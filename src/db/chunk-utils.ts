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

/** Runs `query` once per chunk of `items` and concatenates the rows, keeping chunk order. */
export async function queryInChunks<T, R>(
	items: readonly T[],
	query: (chunk: T[]) => Promise<R[]>,
	size = DEFAULT_IN_ARRAY_CHUNK_SIZE,
): Promise<R[]> {
	if (items.length === 0) return [];
	if (items.length <= size) return query([...items]);
	const results = await Promise.all(chunkArray(items, size).map((chunk) => query(chunk)));
	return results.flat();
}

/** Runs a write once per chunk; writes stay sequential so a failure leaves earlier chunks applied in order. */
export async function runInChunks<T>(
	items: readonly T[],
	run: (chunk: T[]) => Promise<unknown>,
	size = DEFAULT_IN_ARRAY_CHUNK_SIZE,
): Promise<void> {
	for (const chunk of chunkArray(items, size)) await run(chunk);
}
