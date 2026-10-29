import type { BulkMessageResponse } from "@/app/api/messages/bulk/types";

/** The code the bulk endpoint answers (409, nothing changed) when a Delete or Trash would delete drafts. */
const DRAFTS_NEED_CONFIRMATION = "DRAFTS_NEED_CONFIRMATION";

/** How many of the user's own drafts a refused bulk request held, or null when it was refused for another reason. */
export function draftsNeedingConfirmation(status: number, body: BulkMessageResponse | null): number | null {
	if (status !== 409 || body?.code !== DRAFTS_NEED_CONFIRMATION) return null;
	return Math.max(body.drafts ?? 1, 1);
}

/** The question asked before a Delete or Trash deletes drafts, which never go to Trash and can't be restored. */
export function draftDeletionConfirmation(count: number) {
	return {
		title: count === 1 ? "Delete a draft permanently?" : `Delete ${count} drafts permanently?`,
		description:
			"Drafts don't go to Trash, where everyone with access to the mailbox would see them. Deleted drafts and their attachments can't be restored; the rest of the selection goes to Trash as usual.",
		confirmLabel: "Delete",
	};
}

/** The notice after drafts were deleted; Undo is offered only for the rest of the selection. */
export function describeDraftsDeleted(count: number): string {
	return count === 1 ? "1 draft deleted permanently" : `${count} drafts deleted permanently`;
}
