import { msg, t } from "@/lib/i18n/translator";
import type { FolderMoveTarget } from "./manage-types";

/** Messages moved per statement: each batch binds only the folder, the mailbox and this limit, far under D1's 100. */
export const FOLDER_MOVE_BATCH_SIZE = 500;

/** Batches before a delete gives up (one million messages); a retry continues where it stopped. */
export const FOLDER_MOVE_MAX_BATCHES = 2_000;

export const FOLDER_MOVE_TARGETS: readonly FolderMoveTarget[] = ["archive", "inbox"];

export const FOLDER_MOVE_LABELS: Record<FolderMoveTarget, string> = {
	archive: msg("folder|Archive"),
	inbox: msg("Inbox"),
};

/** The sentence under "Delete folder X?": how much mail and how many rules the delete touches. */
export function folderDeleteSummary({ messageCount, ruleCount }: { messageCount: number; ruleCount: number }): string {
	const mail = t("{count, plural, =0 {It holds no messages.} one {# message.} other {# messages.}}", {
		count: messageCount,
	});
	if (ruleCount === 0) return mail;
	const rules = t(
		"{count, plural, one {# inbox rule files mail into this folder; it will be turned off.} other {# inbox rules file mail into this folder; they will be turned off.}}",
		{ count: ruleCount },
	);
	return `${mail} ${rules}`;
}
