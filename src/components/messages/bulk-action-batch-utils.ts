import type { BulkMessageResponse } from "@/app/api/messages/bulk/types";

/**
 * Ids per request for an action whose server side is a sequential per-message loop: reporting spam or phishing
 * (each message trains the spam filter and writes its own receipt) and restoring a batch Undo brings back (each
 * state may undo a receipt's training too). "Select all in folder" can select up to a thousand rows, more once
 * conversation view expands them, so one request per message would risk a Worker's time and subrequest limits;
 * this keeps every request to a bounded number of messages, the same way permanently deleting a page does.
 */
export const TRAINING_ACTION_BATCH_SIZE = 50;

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
	if (items.length === 0) return [];
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
}

/**
 * Combines the responses of several batched bulk-action requests into the one a single request would have
 * answered. A single response (every call outside "Select all in folder" and its kind) is returned exactly as
 * it came, so no field a future response may carry is ever silently dropped here.
 */
export function mergeBulkResponses(responses: readonly BulkMessageResponse[]): BulkMessageResponse {
	if (responses.length === 0) return { ok: true };
	if (responses.length === 1) return responses[0];
	const sum = (pick: (response: BulkMessageResponse) => number | undefined) =>
		responses.reduce((total, response) => total + (pick(response) ?? 0), 0);
	return {
		ok: responses.every((response) => response.ok !== false),
		undo: responses.flatMap((response) => response.undo ?? []),
		moved: responses.flatMap((response) => response.moved ?? []),
		reports: responses.flatMap((response) => response.reports ?? []),
		trainingUndoUnavailable: responses.some((response) => response.trainingUndoUnavailable === true),
		superseded: sum((response) => response.superseded),
		deleted: sum((response) => response.deleted),
		skipped: sum((response) => response.skipped),
		drafts: sum((response) => response.drafts),
		draftsDeleted: sum((response) => response.draftsDeleted),
		draftsRefused: sum((response) => response.draftsRefused),
		sendPendingRefused: sum((response) => response.sendPendingRefused),
	};
}
