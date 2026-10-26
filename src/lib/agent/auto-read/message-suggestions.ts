import { and, count, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { queryInChunks } from "@/db/chunk-utils";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import type { MailboxPermission } from "@/lib/mailboxes/types";
import { rowConversationKey } from "@/lib/messages/conversation-key";
import { groupSuggestionCounts } from "./suggestion-badge-utils";
import type { SuggestionCount } from "./suggestion-types";
import { visibleSuggestionsWhere, type SuggestionVisibility } from "./suggestion-visibility";

// Conversation rows are keyed per mailbox, as the message list groups them.
type ListRow = { id: string; mailboxId: string | null; threadId: string | null };

/**
 * Open suggestion counts for the rows of a message list, in one grouped query over every message the
 * rows stand for. Only rows in mailboxes where the user has full access get any, and kinds owned by a
 * module that is off for the user, or reviewer-only kinds someone else reviews, are left out. Returns the field to
 * spread into each row: `{ agentSuggestions }`, or nothing.
 */
export async function loadRowSuggestions(
	db: AppDatabase,
	mailboxes: readonly { id: string; permission: MailboxPermission }[],
	rows: readonly ListRow[],
	threadMessageIds: ReadonlyMap<string, string[]>,
	visibility: SuggestionVisibility | null = null,
): Promise<(rowId: string) => { agentSuggestions?: SuggestionCount[] }> {
	const fullAccess = new Set(mailboxes.filter((mailbox) => mailbox.permission === "full_access").map(({ id }) => id));
	const members = rows
		.filter((row) => row.mailboxId && fullAccess.has(row.mailboxId))
		.map((row) => ({ id: row.id, messageIds: threadMessageIds.get(rowConversationKey(row)) ?? [row.id] }));
	const messageIds = Array.from(new Set(members.flatMap((row) => row.messageIds)));
	const counts = await queryInChunks(messageIds, (chunk) =>
		db
			.select({
				messageId: agentSuggestions.messageId,
				mailboxId: agentSuggestions.mailboxId,
				kind: agentSuggestions.kind,
				count: count(),
			})
			.from(agentSuggestions)
			.where(
				and(
					eq(agentSuggestions.status, "open"),
					inArray(agentSuggestions.messageId, chunk),
					visibleSuggestionsWhere(visibility),
				),
			)
			.groupBy(agentSuggestions.messageId, agentSuggestions.mailboxId, agentSuggestions.kind),
	);
	const byRow = groupSuggestionCounts(
		counts.filter((row) => fullAccess.has(row.mailboxId)),
		members,
	);
	return (rowId) => {
		const agentSuggestions = byRow.get(rowId);
		return agentSuggestions ? { agentSuggestions } : {};
	};
}
