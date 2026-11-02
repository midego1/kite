import type { FolderMoveTarget } from "./manage-types";

/** Messages moved per statement: each batch binds only the folder, the mailbox and this limit, far under D1's 100. */
export const FOLDER_MOVE_BATCH_SIZE = 500;

/** Batches before a delete gives up (one million messages); a retry continues where it stopped. */
export const FOLDER_MOVE_MAX_BATCHES = 2_000;

export const FOLDER_MOVE_TARGETS: readonly FolderMoveTarget[] = ["archive", "inbox"];

export const FOLDER_MOVE_LABELS: Record<FolderMoveTarget, string> = { archive: "Archive", inbox: "Inbox" };

/** The sentence under "Delete folder X?": how much mail and how many rules the delete touches. */
export function folderDeleteSummary({ messageCount, ruleCount }: { messageCount: number; ruleCount: number }): string {
	const mail =
		messageCount === 0
			? "It holds no messages."
			: `${messageCount.toLocaleString("en-US")} ${messageCount === 1 ? "message" : "messages"}`;
	const rules =
		ruleCount === 0
			? ""
			: ` ${ruleCount === 1 ? "1 inbox rule files" : `${ruleCount} inbox rules file`} mail into this folder; ${ruleCount === 1 ? "it" : "they"} will be turned off.`;
	return `${mail}${messageCount === 0 ? "" : "."}${rules}`;
}
