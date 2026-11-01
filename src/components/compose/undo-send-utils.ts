import type { PendingUndoSend, PendingUndoSnapshot, SentAnswer } from "./undo-send-types";

/** Hide the bar slightly before the queue releases the message, so a late click does not race the delivery. */
export const UNDO_SAFETY_MARGIN_MS = 750;

/** Whole seconds left on the undo bar's countdown, never below zero. */
export function undoCountdownSeconds(until: number, now: number): number {
	return Math.max(0, Math.ceil((until - UNDO_SAFETY_MARGIN_MS - now) / 1000));
}

/** Where the held or scheduled message can be opened: the queued message is listed in Sent right away. */
export function sentMessageHref(messageId: string): string {
	return /^[\w-]+$/.test(messageId) ? `/sent/${messageId}` : "/sent";
}

/** The message the undo window holds, from the send answer; null when it was sent or scheduled without one. */
export function heldSend(answer: SentAnswer, snapshot: PendingUndoSnapshot): PendingUndoSend | null {
	if (!answer.undoUntil || !answer.messageId) return null;
	return { messageId: answer.messageId, until: new Date(answer.undoUntil).getTime(), snapshot };
}
