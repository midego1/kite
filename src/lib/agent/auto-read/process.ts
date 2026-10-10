import { eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { agentJobs, mailboxAgentSettings, mailboxes, messages, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { claimAgentJob, failAndRequeueAgentJob, skipAgentJob } from "../jobs/lease";
import { getAgentProviderConfig } from "../provider";
import { needsModel } from "./facts-utils";
import { getAutoReadInstallSettings } from "./install-settings";
import { planSuggestions } from "./policy-utils";
import { isPaused } from "./schedule-utils";
import type { AutoReadInstallSettings } from "./settings-types";
import { resolveMailboxAgentSettings } from "./settings-utils";
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

/** The reviewer's access on the mailbox, or null when the reviewer can no longer read it. */
async function reviewerAccess(db: AppDatabase, job: AgentJobRow) {
	const [reviewer] = await db.select().from(users).where(eq(users.id, job.reviewerUserId)).limit(1);
	if (!reviewer || reviewer.disabled) return null;
	const access = await getMailboxAccessLevel(db, reviewer, job.mailboxId);
	return access?.canRead ? access : null;
}

/** Triages the claimed job's message; returns a skip reason, or null once its suggestions are stored. */
async function triage(env: CloudflareEnv, db: AppDatabase, job: AgentJobRow): Promise<string | null> {
	const install = await getAutoReadInstallSettings(env);
	const [row] = await db
		.select()
		.from(mailboxAgentSettings)
		.where(eq(mailboxAgentSettings.mailboxId, job.mailboxId))
		.limit(1);
	const [source] = await db.select().from(messages).where(eq(messages.id, job.sourceMessageId)).limit(1);
	const skip = triageSkipReason(install, row, source);
	if (skip || !row || !source) return skip ?? "source_changed";
	const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, job.mailboxId)).limit(1);
	const access = mailbox && (await reviewerAccess(db, job));
	if (!mailbox || !access) return "reviewer_unavailable";
	const settings = resolveMailboxAgentSettings(row, {
		mailboxId: mailbox.id,
		ownerUserId: mailbox.userId,
		mailboxType: mailbox.type,
	});
	const context = await loadTriageContext(env, source, job.reviewerUserId);
	let model: Awaited<ReturnType<typeof runTriageModel>> | null = null;
	if (needsModel(context.facts, settings.capabilities)) {
		const config = await getAgentProviderConfig(env);
		if (config.provider === "compatible" && !install.externalAutoReadAllowed) return "external_provider_not_allowed";
		model = await runTriageModel({
			env,
			job,
			settings,
			context,
			config,
			installCapMicros: install.dailySpendCapMicros,
		});
	}
	const planned = planSuggestions({
		facts: context.facts,
		triage: model?.result ?? null,
		settings: {
			capabilities: settings.capabilities,
			canDraftReply: access.canSendOnBehalf,
			filed: !!source.folderId,
			threadMessageCount: context.threadMessageCount,
		},
	});
	await storeTriageSuggestions({ env, job, source, planned, model: model?.modelId ?? null });
	return null;
}

export async function processAgentTriageJob(env: CloudflareEnv, jobId: string) {
	const db = getDb(env);
	const job = await claimAgentJob(db, jobId);
	if (!job) return;
	try {
		const reason = await triage(env, db, job);
		if (reason) return void (await skipAgentJob(db, jobId, reason));
		await db.update(agentJobs).set({ status: "completed", leaseUntil: null }).where(eq(agentJobs.id, jobId));
	} catch (error) {
		if (error instanceof SpendCapReachedError) return void (await skipAgentJob(db, jobId, "spend_cap"));
		await failAndRequeueAgentJob(env, db, job, error);
	}
}
