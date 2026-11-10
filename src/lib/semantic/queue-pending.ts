import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";

/**
 * Inserts `pending` rows into `message_embeddings`, shared by the backfill and the mailbox requeue (R1/R2 of
 * review round 2): raw SQL naming exactly the four columns both callers ever set, so each row binds 4 parameters,
 * not whatever Drizzle's `.insert().values()` binds for every `notNull().default(...)` column it leaves
 * unspecified (`status`, `chunk_count`, `attempts`), which pushed a 20-row chunk past D1's 100-parameter limit.
 */

/** `origin` is `backfill` only for a page of the install backfill; everything else is `live` (the column default). */
export type PendingEmbeddingRow = { id: string; mailboxId: string; queuedAt: Date; origin?: "live" | "backfill" };

/** Rows are inserted in batches this small: 5 parameters each, well under D1's 100-parameter limit. */
const INSERT_CHUNK_SIZE = 16;

/** Whether `error` is the missing `message_embeddings.origin` column of a database that has not applied 0110. */
function isMissingOriginColumn(error: unknown): boolean {
	return missingColumnFromError(error) === "origin";
}

/**
 * Runs `withOrigin`, or `withoutOrigin` on a database that has not applied migration 0110 yet (the drain then
 * falls back to classifying a row by the age of its `queued_at`, so nothing is lost by not writing the column).
 */
export async function withOriginColumn<T>(withOrigin: () => Promise<T>, withoutOrigin: () => Promise<T>): Promise<T> {
	try {
		return await withOrigin();
	} catch (error) {
		if (!isMissingOriginColumn(error)) throw error;
		return withoutOrigin();
	}
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

/**
 * Inserts one chunk ignoring an existing row (`message_id` is the primary key). Only a row that is not `live`
 * names the `origin` column, so the common insert keeps working on a database before migration 0110.
 */
export async function insertPendingEmbeddingRows(
	env: CloudflareEnv,
	rows: readonly PendingEmbeddingRow[],
): Promise<void> {
	for (const batch of chunks(rows, INSERT_CHUNK_SIZE)) {
		const plain = () => {
			const tuples = batch.map(() => "(?, ?, 'pending', ?)").join(", ");
			return env.DB.prepare(
				`INSERT OR IGNORE INTO message_embeddings (message_id, mailbox_id, status, queued_at) VALUES ${tuples}`,
			)
				.bind(...batch.flatMap((row) => [row.id, row.mailboxId, Math.floor(row.queuedAt.getTime() / 1000)]))
				.run();
		};
		if (!batch.some((row) => row.origin === "backfill")) {
			await plain();
			continue;
		}
		await withOriginColumn(() => {
			const tuples = batch.map(() => "(?, ?, 'pending', ?, ?)").join(", ");
			return env.DB.prepare(
				`INSERT OR IGNORE INTO message_embeddings (message_id, mailbox_id, status, queued_at, origin) VALUES ${tuples}`,
			)
				.bind(
					...batch.flatMap((row) => [
						row.id,
						row.mailboxId,
						Math.floor(row.queuedAt.getTime() / 1000),
						row.origin ?? "live",
					]),
				)
				.run();
		}, plain);
	}
}
