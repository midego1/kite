import type { MailboxPurgeMessage } from "./delete-types";

/** Messages removed per round; keeps every IN (...) list under D1's 100 bound parameters. */
export const MAILBOX_PURGE_BATCH_SIZE = 50;
/** Time a request spends purging before the rest moves to the queue. */
export const MAILBOX_PURGE_REQUEST_BUDGET_MS = 10_000;
/** Time one queue invocation spends purging before it re-enqueues itself. */
export const MAILBOX_PURGE_QUEUE_BUDGET_MS = 20_000;
/** R2 deletes at most this many keys per call. */
export const R2_DELETE_BATCH_SIZE = 1000;

export function isMailboxPurgeMessage(payload: unknown): payload is MailboxPurgeMessage {
	return (
		typeof payload === "object" &&
		payload !== null &&
		(payload as { kind?: unknown }).kind === "mailbox.purge" &&
		typeof (payload as { mailboxId?: unknown }).mailboxId === "string"
	);
}

export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
}
