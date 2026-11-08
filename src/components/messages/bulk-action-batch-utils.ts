import type { BulkMessageResponse } from "@/app/api/messages/bulk/types";

/**
 * Ids per bulk-action (and restore) request. "Select all in folder" can select up to a thousand rows, more once
 * conversation view expands them, and one request's server-side work scales with how many ids it carries: a
 * sequential per-message loop for spam, phishing and restoring a training receipt, and otherwise roughly 20
 * SELECT/UPDATE pairs and up to 84 audit inserts per 1,000 ids, well past the ~50 D1 queries a Workers Free
 * invocation allows (`docs/operations.md`). Every bulk action is batched at this size, the same as permanently
 * deleting a page.
 */
export const BULK_ACTION_BATCH_SIZE = 50;

/**
 * Thrown by `runBulkMessageAction` when a later batch failed (or the user declined a mid-run drafts
 * confirmation) after at least one earlier batch had already gone through. The earlier batches' effects (Undo,
 * the list refresh, the left-view announcement) still ran before this was thrown; `completed`/`total` let the
 * caller say how far it got instead of a plain "could not update the messages", and `completedIds` lets it drop
 * exactly those from the selection and from any optimistic-state rollback, so a retry never re-sends an id that
 * already went through and a row that already changed is not flipped back only to be corrected again.
 */
export class PartialBulkActionError extends Error {
	constructor(
		message: string,
		readonly completed: number,
		readonly total: number,
		readonly completedIds: readonly string[] = [],
	) {
		super(message);
		this.name = "PartialBulkActionError";
	}
}

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
