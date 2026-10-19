import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** D1 rejects a statement with more than 100 bound parameters. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * Leaves room for the other parameters a statement binds next to its
 * `IN (...)` list (scope, status and search filters).
 */
export const DEFAULT_IN_ARRAY_CHUNK_SIZE = 50;

export function chunkArray<T>(items: readonly T[], size = DEFAULT_IN_ARRAY_CHUNK_SIZE): T[][] {
	if (!Number.isInteger(size) || size < 1) throw new RangeError("Chunk size must be a positive integer");
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
}

/**
 * Runs `query` once per chunk of `items` and concatenates the rows, keeping chunk order.
 * Repeated items are dropped first: one `IN (...)` list matches a row once however often it names
 * it, but two copies in different chunks would return that row twice.
 */
export async function queryInChunks<T, R>(
	items: readonly T[],
	query: (chunk: T[]) => Promise<R[]>,
	size = DEFAULT_IN_ARRAY_CHUNK_SIZE,
): Promise<R[]> {
	const unique = [...new Set(items)];
	if (unique.length === 0) return [];
	if (unique.length <= size) return query(unique);
	const results = await Promise.all(chunkArray(unique, size).map((chunk) => query(chunk)));
	return results.flat();
}

/**
 * `column IN (...)` for a list with no useful upper bound, such as every mailbox a user can read,
 * bound as a single JSON parameter so it never counts against D1's cap.
 */
export function inJsonArray(column: SQLWrapper, values: readonly string[]): SQL {
	return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;
}

/** Runs a write once per chunk; writes stay sequential so a failure leaves earlier chunks applied in order. */
export async function runInChunks<T>(
	items: readonly T[],
	run: (chunk: T[]) => Promise<unknown>,
	size = DEFAULT_IN_ARRAY_CHUNK_SIZE,
): Promise<void> {
	for (const chunk of chunkArray(items, size)) await run(chunk);
}
