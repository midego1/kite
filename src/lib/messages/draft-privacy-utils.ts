/** The status of an unsent message. */
export const DRAFT_STATUS = "draft";

/**
 * Drafts are private to the user who wrote them (`messages.userId`), even in a shared mailbox and
 * even to the mailbox's owner or an admin: anyone else is told the message does not exist.
 */
export function isHiddenDraft(row: { status: string; userId: string }, viewerId: string): boolean {
	return row.status === DRAFT_STATUS && row.userId !== viewerId;
}
