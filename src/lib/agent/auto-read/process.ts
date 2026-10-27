import { eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { agentJobs, mailboxAgentSettings, mailboxes, messages, users } from "@/db/schema";
import { readMailboxAgentSettingsRow } from "./mailbox-settings";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { normalizeTimeZone } from "@/lib/time/utils";
import { claimAgentJob, failAndRequeueAgentJob, isLastAttempt, skipAgentJob } from "../jobs/lease";
import { getAgentProviderConfig } from "../provider";
import { ExternalProviderNotAllowedError } from "./auto-read-model";
import { hintsAllowed, needsModel } from "./facts-utils";
import { getAutoReadInstallSettings } from "./install-settings";
import { joinSkipReasons } from "./module-steps-utils";
import { activeModelExtensions, modelHintsAsk, runModuleTriageSteps, type StepRunInput } from "./module-steps";
import type { ActiveModelExtension } from "./model-extension-utils";
import { assessPhishing, planSuggestions } from "./policy-utils";
import { allowAutoReadRequest, triageDailyLimitReached } from "./quota";
import { createReplySuggestion } from "./reply-suggestion";
import { isAutoSubmitted, isPaused } from "./schedule-utils";
import type { MessageFacts } from "./facts-types";
import type { PlanInput } from "./policy-types";
import type { AutoReadCapabilities, AutoReadInstallSettings } from "./settings-types";
import { resolveMailboxAgentSettings } from "./settings-utils";
import { settleTriageSuggestions } from "./suggestion-lifecycle";
import { storeTriageSuggestions } from "./suggestions";
import { loadTriageContext } from "./triage-context";
import { runTriageModel, SpendCapReachedError } from "./triage-run";

type AgentJobRow = typeof agentJobs.$inferSelect;

function triageSkipReason(
	install: AutoReadInstallSettings,
	settings: typeof mailboxAgentSettings.$inferSelect | undefined,
	source: typeof messages.$inferSelect | undefined,
) {
	if (!install.agentEnabled) return "assistant_disabled";
	if (!install.autoReadEnabled) return "kill_switch";
	if (!settings || settings.autonomy === "off") return "autonomy_off";
	if (isPaused(settings.pausedUntil)) return "paused";
	if (source?.status !== "received") return "source_changed";
	return null;
}

/** The reviewer and their access on the mailbox, or null when the reviewer can no longer read it. */
async function reviewerAccess(db: AppDatabase, job: AgentJobRow) {
	const [reviewer] = await db.select().from(users).where(eq(users.id, job.reviewerUserId)).limit(1);
	if (!reviewer || reviewer.disabled) return null;
	const access = await getMailboxAccessLevel(db, reviewer, job.mailboxId);
	return access?.canRead ? { reviewer, access } : null;
}

type TriageModelRun = Awaited<ReturnType<typeof runTriageModel>>;
/**
 * The model's part of a job. `hintOnly` is true when only a module's `wantsModel` hint asked for the
 * request, so core plans its own kinds as if the model had not run. `error` is kept for a failed request.
 */
type ModelStep = { skip: string | null; model: TriageModelRun | null; hintOnly: boolean; error?: unknown };

const NO_MODEL: ModelStep = { skip: null, model: null, hintOnly: false };

/** A refusal thrown from inside the model call, as the code the job records. */
function thrownRefusal(error: unknown): string | null {
	if (error instanceof SpendCapReachedError) return "spend_cap";
	if (error instanceof ExternalProviderNotAllowedError) return "external_provider_not_allowed";
	return null;
}

/**
 * Makes the one tool-less model call, or names why it cannot be made. A failed call is retried by the job
 * only when core itself needed the model and attempts are left; a hint-only request is never retried, and
 * either way the module steps then run without the model (`model_failed`).
 */
async function modelStep(input: {
	env: CloudflareEnv;
	job: AgentJobRow;
	settings: ReturnType<typeof resolveMailboxAgentSettings>;
	context: Awaited<ReturnType<typeof loadTriageContext>>;
	install: AutoReadInstallSettings;
	extensions: readonly ActiveModelExtension[];
	hintOnly: boolean;
}): Promise<ModelStep> {
	const { env, job, settings, context, install, extensions, hintOnly } = input;
	const config = await getAgentProviderConfig(env);
	if (config.provider === "compatible" && !install.externalAutoReadAllowed)
		return { skip: "external_provider_not_allowed", model: null, hintOnly };
	if (!(await allowAutoReadRequest(env, job.mailboxId))) return { skip: "rate_limited", model: null, hintOnly };
	try {
		const model = await runTriageModel({
			env,
			job,
			settings,
			context,
			config,
			installCapMicros: install.dailySpendCapMicros,
			tokenCap: install.autoReadTokenCap,
			extensions,
		});
		return { skip: null, model, hintOnly };
	} catch (error) {
		const refusal = thrownRefusal(error);
		if (refusal) return { skip: refusal, model: null, hintOnly };
		if (hintOnly || isLastAttempt(job)) return { skip: "model_failed", model: null, hintOnly, error };
		throw error;
	}
}

/**
 * Whether and how to ask the model: when core needs it (never on a steps-only pass), or when an active
 * module extension's hint asks for it. Every active extension rides along once the request is made.
 */
async function decideModel(input: {
	env: CloudflareEnv;
	job: AgentJobRow;
	settings: ReturnType<typeof resolveMailboxAgentSettings>;
	context: Awaited<ReturnType<typeof loadTriageContext>>;
	install: AutoReadInstallSettings;
	stepRun: StepRunInput;
	stepsOnly: boolean;
}): Promise<ModelStep> {
	const { context, settings, stepRun } = input;
	const extensions = await activeModelExtensions(stepRun);
	const coreNeeds = !input.stepsOnly && needsModel(context.facts, settings.capabilities);
	const hinted =
		!coreNeeds &&
		extensions.length > 0 &&
		hintsAllowed(context.facts, settings.capabilities) &&
		(await modelHintsAsk(stepRun, extensions));
	if (!coreNeeds && !hinted) return NO_MODEL;
	return modelStep({ ...input, extensions, hintOnly: !coreNeeds });
}

type TriageOutcome = { skip: string; note?: undefined } | { skip: null; note: string | null };

/** Everything the job reads before it looks at the message, or why it stops here. */
async function prepareTriage(env: CloudflareEnv, db: AppDatabase, job: AgentJobRow) {
	const install = await getAutoReadInstallSettings(env);
	const row = await readMailboxAgentSettingsRow(db, job.mailboxId);
	const [source] = await db.select().from(messages).where(eq(messages.id, job.sourceMessageId)).limit(1);
	const skip = triageSkipReason(install, row, source);
	if (skip || !row || !source) return { skip: skip ?? "source_changed" };
	const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, job.mailboxId)).limit(1);
	const reviewed = mailbox && (await reviewerAccess(db, job));
	if (!mailbox || !reviewed) return { skip: "reviewer_unavailable" };
	const settings = resolveMailboxAgentSettings(row, {
		mailboxId: mailbox.id,
		ownerUserId: mailbox.userId,
		mailboxType: mailbox.type,
	});
	if (await triageDailyLimitReached(db, job.mailboxId, settings.autoReadDailyLimit)) return { skip: "daily_limit" };
	return { skip: null, install, source, mailbox, settings, ...reviewed };
}

/**
 * Triages the claimed job's message. Either the job is skipped with a reason, or its suggestions are
 * stored and `note` names why the model was not asked (or why its phishing flag did not warn) and the
 * module steps that were due but skipped because their module is off.
 */
async function triage(env: CloudflareEnv, db: AppDatabase, job: AgentJobRow): Promise<TriageOutcome> {
	const prepared = await prepareTriage(env, db, job);
	if (prepared.skip !== null) return { skip: prepared.skip };
	const { install, source, mailbox, settings, reviewer, access } = prepared;
	const context = await loadTriageContext(env, source, mailbox.userId);
	// Mail a program sent is only let in for the steps that opted in to it; only a module hint can ask the model.
	const stepsOnly = isAutoSubmitted(context.headers);
	const stepRun: StepRunInput = {
		env,
		job,
		reviewer: {
			userId: reviewer.id,
			role: reviewer.role,
			isPrimaryAdmin: reviewer.isPrimaryAdmin,
			timeZone: normalizeTimeZone(reviewer.timeZone),
		},
		source,
		facts: context.facts,
		headers: context.headers,
		bodyText: context.bodyText,
		capabilities: settings.capabilities,
		model: null,
		automaticOnly: stepsOnly,
	};
	const modelRun = await decideModel({ env, job, settings, context, install, stepRun, stepsOnly });
	const steps = await runModuleTriageSteps({ ...stepRun, model: modelRun.model?.result ?? null });
	// A request only a module hint asked for reaches the steps alone: core plans as if the model had not run.
	const model = modelRun.hintOnly ? null : modelRun.model;
	// Module cards can carry links and amounts from the mail; none is offered for mail the model
	// flagged as suspicious, even when only a module hint asked for the request.
	const modelFlagged = !!modelRun.model?.result.suspicious.flagged;
	const planned = planSuggestions({
		facts: context.facts,
		triage: model?.result ?? null,
		moduleSuggestions: modelFlagged ? [] : steps.planned,
		settings: {
			capabilities: settings.capabilities,
			canDraftReply: access.canSendOnBehalf,
			filed: !!source.folderId,
			threadMessageCount: context.threadMessageCount,
		},
	});
	// A refused or failed model must not discard deterministic warnings, even with every module off.
	if (modelRun.skip && steps.ran === 0 && planned.length === 0) {
		if (modelRun.skip === "model_failed" && !modelRun.hintOnly) throw modelRun.error;
		return { skip: modelRun.skip };
	}
	await storeTriageSuggestions({ env, job, source, planned, model: modelRun.model?.modelId ?? null });
	const reply = planned.find((suggestion) => suggestion.kind === "reply");
	if (reply)
		await createReplySuggestion({
			env,
			job,
			source,
			settings,
			facts: context.facts,
			suggestion: reply,
			model: model?.modelId ?? null,
			installCapMicros: install.dailySpendCapMicros,
			tokenCap: install.autoReadTokenCap,
		});
	await settleTriageSuggestions(env, job.mailboxId, source);
	return {
		skip: null,
		note: joinSkipReasons(
			steps.skipped,
			modelRun.skip ?? phishingFlagNote(context.facts, model, settings.capabilities),
		),
	};
}

/** A flag that did not warn is still worth a line in Activity, so the owner can see the model was wary. */
function phishingFlagNote(
	facts: MessageFacts,
	model: { result: NonNullable<PlanInput["triage"]> } | null,
	capabilities: AutoReadCapabilities,
): string | null {
	if (!model || !capabilities.phishing) return null;
	return assessPhishing(facts, model.result, capabilities).note;
}

export async function processAgentTriageJob(env: CloudflareEnv, jobId: string) {
	const db = getDb(env);
	const job = await claimAgentJob(db, jobId);
	if (job === "mailbox_busy") {
		await env.AGENT_QUEUE?.send({ kind: "agent.triage", jobId }, { delaySeconds: 5 });
		return;
	}
	if (!job) return;
	try {
		const outcome = await triage(env, db, job);
		if (outcome.skip) return void (await skipAgentJob(db, jobId, outcome.skip));
		await db
			.update(agentJobs)
			.set({ status: "completed", leaseUntil: null, completedAt: new Date(), reason: outcome.note ?? null })
			.where(eq(agentJobs.id, jobId));
	} catch (error) {
		const refusal = thrownRefusal(error);
		if (refusal) return void (await skipAgentJob(db, jobId, refusal));
		await failAndRequeueAgentJob(env, db, job, error);
	}
}
