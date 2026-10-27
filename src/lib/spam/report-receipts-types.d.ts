import type { ReputationKey, SpamClassification } from "./types";

/** What a phishing report added beyond training, so Undo takes back only that. */
export type ReceiptExtras = {
	/** Who last trained the message before the report; put back on the feedback row by an undo. */
	previousActor?: string | null;
	/**
	 * What blocking the sender added, as two separate facts: whether this report created the mailbox's Trash rule
	 * for the address, and whether the contact was already blocked before. Absent when the sender was kept or the
	 * block was already fully in place.
	 */
	block?: { userId: string; mailboxId: string; address: string; ruleCreated: boolean; contactWasBlocked: boolean };
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

/**
 * `superseded`: a newer report on the same message is still in place, so this one was left untouched and can
 * run after the newer one is undone.
 */
export type ReceiptUndoResult = "undone" | "already_undone" | "missing" | "superseded";
