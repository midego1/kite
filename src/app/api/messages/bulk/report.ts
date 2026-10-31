import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { folders, messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { applySpamFeedbackWithReceipt } from "@/lib/spam/feedback";
import { reportPhishingWithUndo } from "@/lib/spam/phishing-report";
import { undoSpamReceipt } from "@/lib/spam/report-receipts";
import type { BulkMessageResponse, MessageRestoreState } from "./types";

const trainingUndoFlag = (undo: MessageRestoreState[]) =>
	undo.some((state) => !state.receiptId) ? { trainingUndoUnavailable: true } : {};

/** Reports each message as spam; the response carries where each was and the receipt that lets Undo take the training back. */
export async function reportSpamBulk(
	env: CloudflareEnv,
	user: SessionUser,
	messageIds: readonly string[],
): Promise<BulkMessageResponse> {
	const undo: MessageRestoreState[] = [];
	for (const messageId of messageIds) {
		const result = await applySpamFeedbackWithReceipt(env, user, messageId, "spam");
		if (result)
			undo.push({
				id: messageId,
				status: result.previousStatus,
				folderId: result.previousFolderId,
				receiptId: result.receiptId,
			});
	}
	return { ok: true, undo, moved: undo.map((state) => state.id), ...trainingUndoFlag(undo) };
}

export async function reportPhishingBulk(
	env: CloudflareEnv,
	user: SessionUser,
	messageIds: readonly string[],
): Promise<BulkMessageResponse> {
	const outcomes = await reportPhishingWithUndo(env, user, messageIds);
	const undo = outcomes.map((outcome) => outcome.undo);
	return {
		ok: true,
		reports: outcomes.map((outcome) => outcome.report),
		undo,
		moved: undo.map((state) => state.id),
		...trainingUndoFlag(undo),
	};
}

/**
 * Undo of an archive, trash, spam or phishing report. A state with a receipt takes back the report's training and
 * extras too (and only moves the message while it is still in Spam); any other state, or one whose receipt is
 * gone, puts the earlier status and folder back. Returns how many were left alone because a newer report on the
 * same message is still in place.
 */
export async function restoreMessageStates(
	env: CloudflareEnv,
	db: AppDatabase,
	restoreStates: readonly MessageRestoreState[],
	selectedMessages: readonly { id: string; mailboxId: string | null }[],
	approvedMailbox: ReadonlyMap<string, string>,
): Promise<number> {
	let superseded = 0;
	for (const state of restoreStates) {
		const mailboxId = approvedMailbox.get(state.id);
		if (!mailboxId) continue;
		if (typeof state.receiptId === "string") {
			const result = await undoSpamReceipt(env, state.id, state.receiptId);
			if (result === "superseded") superseded += 1;
			if (result !== "missing") continue;
		}
		const message = selectedMessages.find((candidate) => candidate.id === state.id);
		let restoredFolderId: string | null = null;
		if (state.folderId && message?.mailboxId) {
			const [folder] = await db
				.select({ id: folders.id })
				.from(folders)
				.where(and(eq(folders.id, state.folderId), eq(folders.mailboxId, message.mailboxId)))
				.limit(1);
			restoredFolderId = folder?.id ?? null;
		}
		await db
			.update(messages)
			.set({ status: state.status, folderId: restoredFolderId })
			.where(and(eq(messages.id, state.id), eq(messages.mailboxId, mailboxId)));
	}
	return superseded;
}
