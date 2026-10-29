/** The status of an unsent message. */
export const DRAFT_STATUS = "draft";

/**
 * Drafts are private to the user who wrote them (`messages.userId`), even in a shared mailbox and
 * even to the mailbox's owner or an admin: anyone else is told the message does not exist.
 */
export function isHiddenDraft(row: { status: string; userId: string }, viewerId: string): boolean {
	return row.status === DRAFT_STATUS && row.userId !== viewerId;
}

/**
 * Whether a status change would move a message into or out of Drafts. Either would change who can see
 * it (a draft is private, everything else is shared with the mailbox), so a draft leaves Drafts only by
 * being sent or deleted, and nothing else is ever turned into a draft.
 */
export function isDraftMoveRefused(currentStatus: string, targetStatus: string): boolean {
	return (currentStatus === DRAFT_STATUS) !== (targetStatus === DRAFT_STATUS);
}

/** The warning on removing a member's access to a shared mailbox, which deletes their (private) drafts in it. */
export const REMOVE_ACCESS_DESCRIPTION = "Their drafts in this mailbox will be deleted. This can't be undone.";
