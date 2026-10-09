export type BulkMessageAction =
	"archive" | "trash" | "spam" | "read" | "unread" | "inbox" | "folder" | "delete" | "restore";

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
export type MessageRestoreState = { id: string; status: string; folderId: string | null };

export type BulkMessageResponse = {
	ok?: boolean;
	error?: string;
	deleted?: number;
	skipped?: number;
	undo?: MessageRestoreState[];
};
