/**
 * Inserts `pending` rows into `message_embeddings`, shared by the backfill and the mailbox requeue (R1/R2 of
 * review round 2): raw SQL naming exactly the four columns both callers ever set, so each row binds 4 parameters,
 * not whatever Drizzle's `.insert().values()` binds for every `notNull().default(...)` column it leaves
 * unspecified (`status`, `chunk_count`, `attempts`), which pushed a 20-row chunk past D1's 100-parameter limit.
 */

export type PendingEmbeddingRow = { id: string; mailboxId: string; queuedAt: Date };

/** Rows are inserted in batches this small: 4 parameters each, well under D1's 100-parameter limit. */
const INSERT_CHUNK_SIZE = 20;

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

/** Inserts one chunk ignoring an existing row (`message_id` is the primary key). */
export async function insertPendingEmbeddingRows(
	env: CloudflareEnv,
	rows: readonly PendingEmbeddingRow[],
): Promise<void> {
	for (const batch of chunks(rows, INSERT_CHUNK_SIZE)) {
		const tuples = batch.map(() => "(?, ?, 'pending', ?)").join(", ");
		await env.DB.prepare(
			`INSERT OR IGNORE INTO message_embeddings (message_id, mailbox_id, status, queued_at) VALUES ${tuples}`,
		)
			.bind(...batch.flatMap((row) => [row.id, row.mailboxId, Math.floor(row.queuedAt.getTime() / 1000)]))
			.run();
	}
}
