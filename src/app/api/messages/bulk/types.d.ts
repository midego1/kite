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
	/** For "phishing": what happened to each reported message's sender. */
	reports?: PhishingReport[];
};
