import { DRAFT_STATUS, isDraftMoveRefused } from "@/lib/messages/draft-privacy-utils";
import type { BulkMessageAction, PermanentDeleteFolder } from "./types";

const allowedBulkActions = new Set<BulkMessageAction>([
	"archive",
	"trash",
	"spam",
	"phishing",
	"read",
	"unread",
	"inbox",
	"folder",
	"delete",
	"restore",
]);

/**
 * Statuses an undo may put a message back into. Queued and sending states are
 * left out so an undo can never resurrect a send the outbound queue owns.
 */
const restorableStatuses = new Set(["received", "screening", "sent", "draft", "archived", "spam", "trash"]);

export function isRestorableStatus(status: unknown): status is string {
	return typeof status === "string" && restorableStatuses.has(status);
}

/** Actions whose response carries the previous state so the client can offer undo. */
export function isUndoableBulkAction(action: BulkMessageAction): boolean {
	return action === "archive" || action === "trash";
}

/** Moves that can take a whole conversation along with `conversation: true`: every one that leaves the folder. */
const conversationActions = new Set<BulkMessageAction>(["archive", "trash", "spam", "phishing", "inbox", "folder"]);

export function isConversationBulkAction(action: BulkMessageAction): boolean {
	return conversationActions.has(action);
}

export type ConversationScope = { mailboxId: string; threadId: string; status: string; folderId: string | null };

/**
 * The conversations the given messages stand for in the folder each one is in: same mailbox, thread, status and
 * user folder, the set a grouped list row lists in `threadMessageIds`. Drafts are private to their author and
 * never widen, and a message without a thread is a conversation of its own. One scope per conversation.
 */
export function conversationScopes(
	rows: readonly { mailboxId: string | null; threadId: string | null; status: string; folderId: string | null }[],
): ConversationScope[] {
	const scopes = new Map<string, ConversationScope>();
	for (const row of rows) {
		if (!row.mailboxId || !row.threadId || row.status === DRAFT_STATUS) continue;
		const scope = { mailboxId: row.mailboxId, threadId: row.threadId, status: row.status, folderId: row.folderId };
		scopes.set(JSON.stringify([scope.mailboxId, scope.threadId, scope.status, scope.folderId]), scope);
	}
	return [...scopes.values()];
}

export function isAllowedBulkMessageAction(action: unknown): action is BulkMessageAction {
	return typeof action === "string" && allowedBulkActions.has(action as BulkMessageAction);
}

export function getStatusForBulkAction(action: BulkMessageAction): string | null {
	if (action === "archive") return "archived";
	if (action === "trash") return "trash";
	if (action === "spam" || action === "phishing") return "spam";
	if (action === "inbox") return "received";
	if (action === "folder") return "received";
	return null;
}

export function getReadValueForBulkAction(action: BulkMessageAction): boolean | null {
	if (action === "read") return true;
	if (action === "unread") return false;
	return null;
}

/**
 * Permanent deletion is only offered for mail the user already threw away, so a
 * stray "delete" can never destroy something still in the inbox, a folder or Sent.
 */
export function isPermanentlyDeletableStatus(status: string | null | undefined): status is PermanentDeleteFolder {
	return status === "trash" || status === "spam";
}

export function isPermanentDeleteFolder(folder: unknown): folder is PermanentDeleteFolder {
	return folder === "trash" || folder === "spam";
}

/**
 * The mailbox whose access decides an action on a message, or null to skip it: mail without a
 * mailbox, and mail outside the mailbox of the user folder it would be moved to.
 */
export function actionMailboxId(mailboxId: string | null, folderMailboxId: string | null): string | null {
	if (!mailboxId) return null;
	return !folderMailboxId || mailboxId === folderMailboxId ? mailboxId : null;
}

/**
 * What a bulk action does with a message, as far as Drafts goes: Delete and Trash discard a draft outright
 * (it would otherwise land in Trash, visible to the whole mailbox), read state changes as usual, and every
 * other move into or out of Drafts is refused. `restoreStatus` is the status a restore asks for.
 */
export function bulkDraftHandling(
	action: BulkMessageAction,
	status: string,
	restoreStatus?: string,
): "discard" | "refuse" | "normal" {
	if (action === "read" || action === "unread") return "normal";
	if (status === DRAFT_STATUS) return action === "trash" || action === "delete" ? "discard" : "refuse";
	const target = action === "restore" ? restoreStatus : getStatusForBulkAction(action);
	return target && isDraftMoveRefused(status, target) ? "refuse" : "normal";
}
