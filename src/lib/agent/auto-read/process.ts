import { eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { agentJobs, mailboxAgentSettings, mailboxes, messages, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { normalizeTimeZone } from "@/lib/time/utils";
import { claimAgentJob, failAndRequeueAgentJob, skipAgentJob } from "../jobs/lease";
import { getAgentProviderConfig } from "../provider";
import { ExternalProviderNotAllowedError } from "./auto-read-model";
import { needsModel } from "./facts-utils";
import { getAutoReadInstallSettings } from "./install-settings";
import { joinSkipReasons } from "./module-steps-utils";
import { runModuleTriageSteps } from "./module-steps";
import { planSuggestions } from "./policy-utils";
import { allowAutoReadRequest, triageDailyLimitReached } from "./quota";
import { createReplySuggestion } from "./reply-suggestion";
import { isAutoSubmitted, isPaused } from "./schedule-utils";
import type { AutoReadInstallSettings } from "./settings-types";
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
type ModelStep = { skip: string; model: null } | { skip: null; model: TriageModelRun | null };

/** A refusal thrown from inside the model call, as the code the job records. */
function thrownRefusal(error: unknown): string | null {
	if (error instanceof SpendCapReachedError) return "spend_cap";
	if (error instanceof ExternalProviderNotAllowedError) return "external_provider_not_allowed";
	return null;
}

/** Makes the one tool-less model call when the message needs it, or names why it cannot be made. */
async function modelStep(input: {
	env: CloudflareEnv;
	job: AgentJobRow;
	settings: ReturnType<typeof resolveMailboxAgentSettings>;
	context: Awaited<ReturnType<typeof loadTriageContext>>;
	install: AutoReadInstallSettings;
}): Promise<ModelStep> {
	const { env, job, settings, context, install } = input;
	if (!needsModel(context.facts, settings.capabilities)) return { skip: null, model: null };
	const config = await getAgentProviderConfig(env);
	if (config.provider === "compatible" && !install.externalAutoReadAllowed)
		return { skip: "external_provider_not_allowed", model: null };
	if (!(await allowAutoReadRequest(env, job.mailboxId))) return { skip: "rate_limited", model: null };
	try {
		const model = await runTriageModel({
			env,
			job,
			settings,
			context,
			config,
			installCapMicros: install.dailySpendCapMicros,
		});
		return { skip: null, model };
	} catch (error) {
		const refusal = thrownRefusal(error);
		if (refusal) return { skip: refusal, model: null };
		throw error;
	}
}

type TriageOutcome = { skip: string; note?: undefined } | { skip: null; note: string | null };

/** Everything the job reads before it looks at the message, or why it stops here. */
async function prepareTriage(env: CloudflareEnv, db: AppDatabase, job: AgentJobRow) {
	const install = await getAutoReadInstallSettings(env);
	const [row] = await db
		.select()
		.from(mailboxAgentSettings)
		.where(eq(mailboxAgentSettings.mailboxId, job.mailboxId))
		.limit(1);
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
 * stored and `note` names why the model was not asked and the module steps that were due but skipped
 * because their module is off.
 */
async function triage(env: CloudflareEnv, db: AppDatabase, job: AgentJobRow): Promise<TriageOutcome> {
	const prepared = await prepareTriage(env, db, job);
	if (prepared.skip !== null) return { skip: prepared.skip };
	const { install, source, mailbox, settings, reviewer, access } = prepared;
	const context = await loadTriageContext(env, source, mailbox.userId);
	// Mail a program sent is only let in for the steps that opted in to it, so it gets no model call.
	const stepsOnly = isAutoSubmitted(context.headers);
	const modelRun: ModelStep = stepsOnly
		? { skip: null, model: null }
		: await modelStep({ env, job, settings, context, install });
	const model = modelRun.model;
	const steps = await runModuleTriageSteps({
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
		model: model?.result ?? null,
		automaticOnly: stepsOnly,
	});
	// A refused model only stops the job when no module step ran; otherwise the steps' suggestions are kept.
	if (modelRun.skip && steps.ran === 0) return { skip: modelRun.skip };
	const planned = planSuggestions({
		facts: context.facts,
		triage: model?.result ?? null,
		moduleSuggestions: steps.planned,
		settings: {
			capabilities: settings.capabilities,
			canDraftReply: access.canSendOnBehalf,
			filed: !!source.folderId,
			threadMessageCount: context.threadMessageCount,
		},
	});
	await storeTriageSuggestions({ env, job, source, planned, model: model?.modelId ?? null });
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
		});
	await settleTriageSuggestions(env, job.mailboxId, source);
	return { skip: null, note: joinSkipReasons(steps.skipped, modelRun.skip) };
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
