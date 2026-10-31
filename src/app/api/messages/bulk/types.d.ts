import type { PhishingReport } from "@/lib/spam/phishing-report-types";

export type BulkMessageAction =
	"archive" | "trash" | "spam" | "phishing" | "read" | "unread" | "inbox" | "folder" | "delete" | "restore";

/** Folders whose messages can be permanently deleted or emptied in one go. */
export type PermanentDeleteFolder = "trash" | "spam";

export type BulkMessagePayload = {
	messageIds?: string[];
	action?: BulkMessageAction;
	folderId?: string;
	/** For "restore": the state an undone archive or trash puts each message back into. */
	restore?: MessageRestoreState[];
	/**
	 * For "trash" and "delete": also delete the caller's own drafts in the selection, permanently. Without it a
	 * selection holding drafts changes nothing and answers 409 `DRAFTS_NEED_CONFIRMATION` with their count.
	 */
	deleteDrafts?: boolean;
	/**
	 * For moves out of a folder (archive, trash, spam, phishing, inbox, folder): act on every message of each
	 * one's conversation in the same folder too, as a conversation row in a grouped list does. The reader sends
	 * it in conversation view, so reporting the open message does not leave the rest of its thread behind.
	 */
	conversation?: boolean;
};

/** Where a message was before an archive or trash, as returned for undo. */
export type MessageRestoreState = {
	id: string;
	status: string;
	folderId: string | null;
	/** For a spam or phishing report: the receipt that lets Undo also take back its training and extras. */
	receiptId?: string | null;
};

export type BulkMessageResponse = {
	ok?: boolean;
	error?: string;
	deleted?: number;
	skipped?: number;
	undo?: MessageRestoreState[];
	/** For "restore": messages an Undo left alone because a newer spam report on them is still in place. */
	superseded?: number;
	/** True when a report could not record what it trained, so Undo moves the mail back but cannot untrain it. */
	trainingUndoUnavailable?: boolean;
	/** With 409 `DRAFTS_NEED_CONFIRMATION`: how many of your own drafts the selection holds. */
	drafts?: number;
	code?: string;
	/** Your own drafts a Delete or Trash removed outright: a draft never goes to Trash, where the mailbox would see it. */
	draftsDeleted?: number;
	/** Drafts left where they were, because a draft leaves Drafts only by being sent or deleted. */
	draftsRefused?: number;
	/** Messages waiting in the outbound queue that were left where they are: cancel the send before moving them. */
	sendPendingRefused?: number;
	/** For "phishing": what happened to each reported message's sender. */
	reports?: PhishingReport[];
};
