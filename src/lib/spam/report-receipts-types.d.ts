import type { ReputationKey, SpamClassification } from "./types";

/** What a phishing report added beyond training, so Undo takes back only that. */
export type ReceiptExtras = {
	/** Who last trained the message before the report; put back on the feedback row by an undo. */
	previousActor?: string | null;
	/** The block this report placed. Absent when the sender was already blocked or was kept. */
	block?: { userId: string; mailboxId: string; address: string };
	/** The phishing warnings this report closed. */
	closedSuggestionIds?: string[];
};

export type NewSpamReceipt = {
	messageId: string;
	mailboxId: string;
	actorUserId: string;
	classification: SpamClassification;
	previousClassification: SpamClassification | null;
	trained: boolean;
	createdTokens: string[];
	createdKeys: ReputationKey[];
	previousStatus: string;
	previousFolderId: string | null;
	extras: ReceiptExtras;
};

/** The result of recording a report: the receipt Undo needs, and where the message was before. */
export type SpamFeedbackResult = {
	/** Null when the receipts table is missing (migration 0073 not applied yet) or could not be written. */
	receiptId: string | null;
	previousStatus: string;
	previousFolderId: string | null;
};

export type ReceiptUndoResult = "undone" | "already_undone" | "missing";
