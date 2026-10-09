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
