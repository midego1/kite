/**
 * Body bytes read per query. D1 fails a query whose result passes 50 MB; a row is at most 2 MB, so this
 * leaves a wide margin whatever the mailbox holds.
 */
const BODY_BATCH_BYTES = 8 * 1024 * 1024;

/** Ids per body query, below D1's 100 bound parameters. */
const BODY_BATCH_IDS = 50;

/**
 * Groups rows, in order, into batches whose body bytes stay within `maxBytes` and `maxIds`. A row over the
 * byte limit on its own still gets a batch of its own.
 */
export function planBodyBatches(
	rows: readonly { id: string; bodyBytes: number }[],
	maxBytes = BODY_BATCH_BYTES,
	maxIds = BODY_BATCH_IDS,
): string[][] {
	const batches: string[][] = [];
	let current: string[] = [];
	let bytes = 0;
	for (const row of rows) {
		if (current.length > 0 && (current.length >= maxIds || bytes + row.bodyBytes > maxBytes)) {
			batches.push(current);
			current = [];
			bytes = 0;
		}
		current.push(row.id);
		bytes += row.bodyBytes;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}
