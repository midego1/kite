import { eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { inJsonArray } from "@/db/chunk-utils";
import { messages } from "@/db/schema";

/**
 * Messages in the scoped mailboxes. Several mailboxes are bound as one JSON parameter, so a user
 * with many shared mailboxes never runs into D1's 100-parameter limit; without any accessible
 * mailbox a user still sees their own rows.
 */
export function mailboxScopeCondition(mailboxIds: readonly string[], userId: string): SQL {
	if (mailboxIds.length === 0) return eq(messages.userId, userId);
	if (mailboxIds.length === 1) return eq(messages.mailboxId, mailboxIds[0]);
	return inJsonArray(messages.mailboxId, mailboxIds);
}
