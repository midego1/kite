import { and, eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { agentJobs, mailboxAgentSettings, mailboxes, users } from "@/db/schema";
import { readMailboxAgentSettingsRow } from "./mailbox-settings";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { scheduleAutoDraft } from "../jobs/utils";
import { agentJobQueueMessage } from "../queue-utils";
import { getAutoReadInstallSettings } from "./install-settings";
import { automaticStepOpen } from "./module-steps";
import { isPaused, triageMessageGate, withinRecoveryWindow } from "./schedule-utils";
import { resolveMailboxAgentSettings } from "./settings-utils";
import { supersedeOlderReplies } from "./suggestion-lifecycle";

export type AgentWorkInput = Parameters<typeof scheduleAutoDraft>[1] & {
	/** Set on the duplicate-raw-key recovery path: when the already stored message was received. */
	recoveryReceivedAt?: Date;
};

type MailboxSettings = typeof mailboxAgentSettings.$inferSelect;

async function readingReviewer(db: AppDatabase, reviewerUserId: string, mailboxId: string) {
	const [reviewer] = await db.select().from(users).where(eq(users.id, reviewerUserId)).limit(1);
	if (!reviewer || reviewer.disabled) return null;
	return (await getMailboxAccessLevel(db, reviewer, mailboxId))?.canRead ? reviewer : null;
}

/**
 * The same message delivered again under a new raw key is stored twice; only the first copy is
 * triaged. The copy check and the insert are one statement, so two copies scheduled at the same
 * time cannot both see no job and insert one each. A message without a Message-ID matches nothing.
 */
const INSERT_TRIAGE_JOB = `INSERT INTO agent_jobs (id, kind, mailbox_id, source_message_id, reviewer_user_id, status, attempts, next_attempt_at, created_at)
SELECT ?, 'triage', ?, ?, ?, 'pending', 0, ?, ?
WHERE NOT EXISTS (
	SELECT 1 FROM agent_jobs existing JOIN messages stored ON stored.id = existing.source_message_id
	WHERE existing.mailbox_id = ? AND existing.kind = 'triage' AND existing.source_message_id <> ?
	AND stored.provider_message_id = (SELECT provider_message_id FROM messages WHERE id = ?)
)
ON CONFLICT (mailbox_id, source_message_id, kind) DO NOTHING`;

async function insertTriageJob(env: CloudflareEnv, input: AgentWorkInput, reviewerUserId: string) {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(INSERT_TRIAGE_JOB)
		.bind(
			newId("ajob"),
			input.mailboxId,
			input.sourceMessageId,
			reviewerUserId,
			now,
			now,
			input.mailboxId,
			input.sourceMessageId,
			input.sourceMessageId,
		)
		.run();
}

async function triageAllowed(env: CloudflareEnv, input: AgentWorkInput, settings: MailboxSettings) {
	const install = await getAutoReadInstallSettings(env);
	if (!install.agentEnabled || !install.autoReadEnabled || isPaused(settings.pausedUntil)) return false;
	const db = getDb(env);
	const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).limit(1);
	if (!mailbox) return false;
	const ownAddresses = await getMailboxDomainAddresses(db, mailbox);
	const gate = triageMessageGate({ ...input, ownAddresses });
	if (gate && gate !== "auto_submitted") return false;
	const reviewer = await readingReviewer(db, settings.reviewerUserId || input.ownerUserId, input.mailboxId);
	if (!reviewer) return false;
	if (!gate) return true;
	const { capabilities } = resolveMailboxAgentSettings(settings, {
		mailboxId: mailbox.id,
		ownerUserId: mailbox.userId,
		mailboxType: mailbox.type,
	});
	return automaticStepOpen(
		{ userId: reviewer.id, role: reviewer.role, isPrimaryAdmin: reviewer.isPrimaryAdmin },
		capabilities,
	);
}

/**
 * Schedules the automatic work for a delivered message: a triage job when the mailbox reads
 * mail automatically, otherwise the legacy auto-draft job exactly as before.
 */
export async function scheduleAgentWork(env: CloudflareEnv, input: AgentWorkInput) {
	if (!withinRecoveryWindow(input.recoveryReceivedAt)) return;
	const db = getDb(env);
	const settings = await readMailboxAgentSettingsRow(db, input.mailboxId);
	if (!settings) return;
	// Before every gate: the older reply is outdated even when this message is never triaged.
	await supersedeOlderReplies(env, input.sourceMessageId);
	if (settings.autonomy === "off") {
		if (settings.autoDraftEnabled) await scheduleAutoDraft(env, input);
		return;
	}
	if (!(await triageAllowed(env, input, settings))) return;
	await insertTriageJob(env, input, settings.reviewerUserId || input.ownerUserId);
	const [job] = await db
		.select({ id: agentJobs.id, status: agentJobs.status })
		.from(agentJobs)
		.where(
			and(
				eq(agentJobs.mailboxId, input.mailboxId),
				eq(agentJobs.sourceMessageId, input.sourceMessageId),
				eq(agentJobs.kind, "triage"),
			),
		)
		.limit(1);
	if (job?.status === "pending") await env.AGENT_QUEUE?.send(agentJobQueueMessage("triage", job.id));
}
