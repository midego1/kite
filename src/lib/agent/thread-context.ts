import { and, desc, eq, ne, notInArray, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";

type ThreadMessage = typeof messages.$inferSelect;

/**
 * Statuses the assistant never reads as thread context: spam and trash can be written by anyone, and mail held
 * in the Screener comes from senders the user has not approved yet (upstream Mailflare #225).
 */
const AGENT_THREAD_EXCLUDED_STATUSES = ["spam", "trash", SCREENING_STATUS] as const;

/**
 * The rows of a conversation the assistant may read: the anchor itself, plus every other message that is not
 * spam, trash or held in the Screener and is not a draft of someone else. `viewerId` null (background jobs)
 * leaves out every draft.
 */
export function agentThreadCondition(anchorId: string, viewerId: string | null): SQL {
	const drafts = viewerId
		? or(ne(messages.status, "draft"), eq(messages.userId, viewerId))
		: ne(messages.status, "draft");
	return or(eq(messages.id, anchorId), and(notInArray(messages.status, [...AGENT_THREAD_EXCLUDED_STATUSES]), drafts))!;
}

/**
 * The newest `limit` messages of the anchor's conversation in its mailbox that the assistant may read
 * (`agentThreadCondition`), newest first; just the anchor when it has no thread. Shared by `get_thread`, reply
 * drafting and thread summaries so all of them see the same context.
 */
export async function agentThreadRows(
	env: CloudflareEnv,
	input: { mailboxId: string; anchor: ThreadMessage; viewerId: string | null; limit: number },
): Promise<ThreadMessage[]> {
	const { anchor } = input;
	if (!anchor.threadId) return [anchor];
	return getDb(env)
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, input.mailboxId),
				eq(messages.threadId, anchor.threadId),
				agentThreadCondition(anchor.id, input.viewerId),
			),
		)
		.orderBy(desc(messages.createdAt))
		.limit(input.limit);
}
