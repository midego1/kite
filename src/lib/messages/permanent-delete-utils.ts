import type { PermanentDeleteFolder } from "@/app/api/messages/bulk/types";

const folderLabels: Record<PermanentDeleteFolder, string> = { trash: "Trash", spam: "Spam" };

/** Whether the folder being viewed offers "Delete forever" and "Empty …". */
export function supportsPermanentDelete(folder: string | null | undefined): folder is PermanentDeleteFolder {
	return folder === "trash" || folder === "spam";
}

export function getEmptyFolderLabel(folder: PermanentDeleteFolder): string {
	return `Empty ${folderLabels[folder]}`;
}

export function getPermanentDeleteConfirmText(count: number): string {
	const subject = count === 1 ? "this message" : `these ${count} messages`;
	return `Permanently delete ${subject}? This cannot be undone.`;
}

export function getEmptyFolderConfirmText(folder: PermanentDeleteFolder, total?: number): string {
	const what = total === 1 ? "the 1 message" : total && total > 1 ? `all ${total} messages` : "every message";
	return `Permanently delete ${what} in ${folderLabels[folder]}? This cannot be undone.`;
}

const DELETE_SKIPPED_MESSAGE = "Some messages could not be deleted because they are no longer in Trash or Spam.";

/** Some of the requested messages were not in Trash or Spam any more, so the server kept them. */
export class PartialDeleteError extends Error {
	constructor(readonly skipped: number) {
		super(DELETE_SKIPPED_MESSAGE);
		this.name = "PartialDeleteError";
	}
}

/** Throws when a permanent delete answered that it kept some of the messages. */
export function assertNothingSkipped(action: string, response: { skipped?: number } | null | undefined): void {
	if (action !== "delete" || !response?.skipped) return;
	throw new PartialDeleteError(response.skipped);
}

/** What the progress toast says once a permanent delete finished. */
export function describePermanentDeleteResult(deleted: number, skipped: number): { ok: boolean; message: string } {
	const done = deleted === 1 ? "1 message deleted forever" : `${deleted} messages deleted forever`;
	if (skipped > 0)
		return { ok: false, message: deleted > 0 ? `${done}. ${DELETE_SKIPPED_MESSAGE}` : DELETE_SKIPPED_MESSAGE };
	return { ok: true, message: done };
}
