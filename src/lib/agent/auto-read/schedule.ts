import { and, eq, ne } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { agentJobs, mailboxAgentSettings, mailboxes, messages, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { scheduleAutoDraft } from "../jobs/utils";
import { agentJobQueueMessage } from "../queue-utils";
import { getAutoReadInstallSettings } from "./install-settings";
import { isPaused, triageMessageGate, withinRecoveryWindow } from "./schedule-utils";

export type AgentWorkInput = Parameters<typeof scheduleAutoDraft>[1] & {
	/** Set on the duplicate-raw-key recovery path: when the already stored message was received. */
	recoveryReceivedAt?: Date;
};

type MailboxSettings = typeof mailboxAgentSettings.$inferSelect;

async function reviewerCanRead(db: AppDatabase, reviewerUserId: string, mailboxId: string) {
	const [reviewer] = await db.select().from(users).where(eq(users.id, reviewerUserId)).limit(1);
	return !!reviewer && !reviewer.disabled && !!(await getMailboxAccessLevel(db, reviewer, mailboxId))?.canRead;
}

/** The same message delivered again under a new raw key is stored twice; only the first copy is triaged. */
async function alreadyTriagedCopy(db: AppDatabase, mailboxId: string, sourceMessageId: string) {
	const [source] = await db
		.select({ providerMessageId: messages.providerMessageId })
		.from(messages)
		.where(eq(messages.id, sourceMessageId))
		.limit(1);
	if (!source?.providerMessageId) return false;
	const [copy] = await db
		.select({ id: agentJobs.id })
		.from(agentJobs)
		.innerJoin(messages, eq(messages.id, agentJobs.sourceMessageId))
		.where(
			and(
				eq(agentJobs.mailboxId, mailboxId),
				eq(agentJobs.kind, "triage"),
				eq(messages.providerMessageId, source.providerMessageId),
				ne(agentJobs.sourceMessageId, sourceMessageId),
			),
		)
		.limit(1);
	return !!copy;
}

async function triageAllowed(env: CloudflareEnv, input: AgentWorkInput, settings: MailboxSettings) {
	const install = await getAutoReadInstallSettings(env);
	if (!install.agentEnabled || !install.autoReadEnabled || isPaused(settings.pausedUntil)) return false;
	const db = getDb(env);
	const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).limit(1);
	if (!mailbox) return false;
	const ownAddresses = await getMailboxDomainAddresses(db, mailbox);
	if (triageMessageGate({ ...input, ownAddresses })) return false;
	if (!(await reviewerCanRead(db, settings.reviewerUserId || input.ownerUserId, input.mailboxId))) return false;
	return !(await alreadyTriagedCopy(db, input.mailboxId, input.sourceMessageId));
}

/**
 * Schedules the automatic work for a delivered message: a triage job when the mailbox reads
 * mail automatically, otherwise the legacy auto-draft job exactly as before.
 */
export async function scheduleAgentWork(env: CloudflareEnv, input: AgentWorkInput) {
	if (!withinRecoveryWindow(input.recoveryReceivedAt)) return;
	const db = getDb(env);
	const [settings] = await db
		.select()
		.from(mailboxAgentSettings)
		.where(eq(mailboxAgentSettings.mailboxId, input.mailboxId))
		.limit(1);
	if (!settings) return;
	if (settings.autonomy === "off") {
		if (settings.autoDraftEnabled) await scheduleAutoDraft(env, input);
		return;
	}
	if (!(await triageAllowed(env, input, settings))) return;
	await db
		.insert(agentJobs)
		.values({
			id: newId("ajob"),
			kind: "triage",
			mailboxId: input.mailboxId,
			sourceMessageId: input.sourceMessageId,
			reviewerUserId: settings.reviewerUserId || input.ownerUserId,
		})
		.onConflictDoNothing({ target: [agentJobs.mailboxId, agentJobs.sourceMessageId, agentJobs.kind] });
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
