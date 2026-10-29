import { and, eq, ne, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { inJsonArray } from "@/db/chunk-utils";
import { messages } from "@/db/schema";
import { DRAFT_STATUS } from "./draft-privacy-utils";

/**
 * Rows in the scoped mailboxes, drafts of every author included. Several mailboxes are bound as one
 * JSON parameter, so a user with many shared mailboxes never runs into D1's 100-parameter limit;
 * without any accessible mailbox a user still sees their own rows.
 */
export function mailboxRowsCondition(mailboxIds: readonly string[], userId: string): SQL {
	if (mailboxIds.length === 0) return eq(messages.userId, userId);
	if (mailboxIds.length === 1) return eq(messages.mailboxId, mailboxIds[0]);
	return inJsonArray(messages.mailboxId, mailboxIds);
}

/** Everything but other users' drafts, which are private to their author (`isHiddenDraft`). */
export function visibleDraftsCondition(userId: string): SQL {
	return or(ne(messages.status, DRAFT_STATUS), eq(messages.userId, userId))!;
}

/** Messages in the scoped mailboxes that the user may see. */
export function mailboxScopeCondition(mailboxIds: readonly string[], userId: string): SQL {
	return and(mailboxRowsCondition(mailboxIds, userId), visibleDraftsCondition(userId))!;
}
