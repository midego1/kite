import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import type { AgentToolContext } from "./types";

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

export async function requireAccess(context: AgentToolContext, write = false, manage = false) {
	const access = await getMailboxAccessLevel(getDb(context.env), context.user, context.mailboxId);
	if (!access?.canRead || (write && !access.canSendOnBehalf) || (manage && !access.canManage)) {
		throw new Error("Mailbox not found or permission denied");
	}
	return access;
}

export async function ownMessage(context: AgentToolContext, messageId: string, notFoundMessage = "Message not found") {
	await requireAccess(context);
	const [row] = await getDb(context.env)
		.select()
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.mailboxId, context.mailboxId)))
		.limit(1);
	if (!row || row.status === SCREENING_STATUS || (row.status === "draft" && row.userId !== context.user.id))
		throw new Error(notFoundMessage);
	return row;
}
