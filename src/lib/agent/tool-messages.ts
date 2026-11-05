import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import type { AgentToolContext } from "./types";
import { mailboxAiOff } from "./mailbox-ai";
import { MAILBOX_AI_OFF_TOOL_TEXT } from "./mailbox-ai-utils";

export function publicMessage(row: typeof messages.$inferSelect) {
	return {
		id: row.id,
		mailboxId: row.mailboxId,
		from: row.fromAddr,
		to: row.toAddr,
		cc: row.ccAddr,
		subject: row.subject,
		snippet: row.snippet,
		direction: row.direction,
		status: row.status,
		read: row.read,
		starred: row.starred,
		threadId: row.threadId,
		url: `/${row.status === "draft" ? "drafts" : row.status === "received" ? "inbox" : row.status}/${encodeURIComponent(row.id)}`,
		createdAt: row.createdAt,
	};
}

/**
 * The caller's access to the context's mailbox. In the chat, whose tool results go to the AI provider, a mailbox
 * with AI off answers only "AI is off for this mailbox" (a turn can still be running when the switch is turned on).
 */
export async function requireAccess(context: AgentToolContext, write = false, manage = false) {
	const access = await getMailboxAccessLevel(getDb(context.env), context.user, context.mailboxId);
	if (!access?.canRead || (write && !access.canSendOnBehalf) || (manage && !access.canManage)) {
		throw new Error("Mailbox not found or permission denied");
	}
	if (context.origin === "chat" && (await mailboxAiOff(context.env, context.mailboxId)))
		throw new Error(MAILBOX_AI_OFF_TOOL_TEXT);
	return access;
}

/**
 * Asked in the chat for a message of another mailbox the user can read that has AI off: the plain refusal, never
 * its subject or sender. Anything else stays "not found".
 */
async function refuseAiOffMessage(context: AgentToolContext, messageId: string): Promise<void> {
	if (context.origin !== "chat") return;
	const db = getDb(context.env);
	const [row] = await db
		.select({ mailboxId: messages.mailboxId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!row?.mailboxId || row.mailboxId === context.mailboxId) return;
	if (!(await getMailboxAccessLevel(db, context.user, row.mailboxId))?.canRead) return;
	if (await mailboxAiOff(context.env, row.mailboxId)) throw new Error(MAILBOX_AI_OFF_TOOL_TEXT);
}

export async function ownMessage(context: AgentToolContext, messageId: string, notFoundMessage = "Message not found") {
	await requireAccess(context);
	const [row] = await getDb(context.env)
		.select()
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.mailboxId, context.mailboxId)))
		.limit(1);
	if (!row || row.status === SCREENING_STATUS || (row.status === "draft" && row.userId !== context.user.id)) {
		if (!row) await refuseAiOffMessage(context, messageId);
		throw new Error(notFoundMessage);
	}
	return row;
}
