import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { messages } from "@/db/schema";

const SEPARATOR = "\u001f";

/**
 * The conversation a stored message belongs to in conversation view. Messages that were never
 * threaded (older rows, drafts) stand alone, and a conversation never spans mailboxes: the same
 * Message-ID delivered to two mailboxes is one thread in each.
 */
export function conversationKey(): SQL<string> {
	return sql<string>`coalesce(${messages.threadId}, ${messages.id}) || char(31) || coalesce(${messages.mailboxId}, '')`;
}

/** `conversationKey()` for a row already loaded. */
export function rowConversationKey(row: { id: string; threadId: string | null; mailboxId: string | null }): string {
	return `${row.threadId ?? row.id}${SEPARATOR}${row.mailboxId ?? ""}`;
}
