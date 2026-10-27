import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentSendApprovals, messages, outboundJobs } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";
import { sentDraftState } from "./draft-state-utils";
import type { AgentDraftState } from "./types";

/**
 * Where an assistant draft stands for its owner: still a draft, sent (or scheduled) by a confirmed
 * approval, or gone. Only the owner's own drafts and approvals are consulted, and the sent message's
 * subject and recipients are shared only with a user who can read its mailbox.
 */
export async function getAgentDraftState(
	env: CloudflareEnv,
	user: SessionUser,
	draftId: string,
): Promise<AgentDraftState> {
	const db = getDb(env);
	const [draft] = await db
		.select({ userId: messages.userId, status: messages.status })
		.from(messages)
		.where(eq(messages.id, draftId))
		.limit(1);
	if (draft && draft.userId === user.id && draft.status === "draft") return { state: "draft" };

	const [approval] = await db
		.select({ messageId: agentSendApprovals.messageId })
		.from(agentSendApprovals)
		.where(
			and(
				eq(agentSendApprovals.draftId, draftId),
				eq(agentSendApprovals.userId, user.id),
				eq(agentSendApprovals.status, "sent"),
			),
		)
		.limit(1);
	const approvedMessageId = approval?.messageId ?? null;
	if (!approvedMessageId) return sentDraftState({ approvedMessageId, message: null, job: null, now: new Date() });

	const [sent] = await db
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			status: messages.status,
			subject: messages.subject,
			toAddr: messages.toAddr,
		})
		.from(messages)
		.where(eq(messages.id, approvedMessageId))
		.limit(1);
	const readable = !!sent?.mailboxId && !!(await getMailboxAccessLevel(db, user, sent.mailboxId))?.canRead;
	const [job] = sent
		? await db
				.select({ status: outboundJobs.status, scheduledAt: outboundJobs.scheduledAt })
				.from(outboundJobs)
				.where(eq(outboundJobs.messageId, approvedMessageId))
				.limit(1)
		: [];
	return sentDraftState({
		approvedMessageId,
		message: sent && readable ? sent : null,
		job: job ?? null,
		now: new Date(),
	});
}
