/**
 * Pure helpers for vector store ids and the Vectorize metadata filter (`docs/specs/semantic-search.md` section 4.3).
 * No `env`, no bindings: `vectorize-store.ts` and `sqlite-vector-store.test.mjs`-style fixtures both use these.
 */

/** Vectorize accepts at most this many bytes of filter JSON. */
const MAX_FILTER_BYTES = 2048;
/** Mailbox ids are about 30 bytes; this keeps every group's filter comfortably under the byte limit too. */
const MAX_IDS_PER_GROUP = 40;

function filterBytes(ids: readonly string[]): number {
	return new TextEncoder().encode(JSON.stringify({ mailboxId: { $in: ids } })).length;
}

/**
 * Splits `mailboxIds` into groups a single Vectorize `$in` filter can carry: at most `MAX_IDS_PER_GROUP` ids, and
 * never over `MAX_FILTER_BYTES` of encoded filter JSON. Each group becomes one `query()` call; callers merge by
 * score. An empty input returns no groups.
 */
export function groupMailboxIdsForFilter(
	mailboxIds: readonly string[],
	options: { maxIdsPerGroup?: number; maxFilterBytes?: number } = {},
): string[][] {
	const maxIds = options.maxIdsPerGroup ?? MAX_IDS_PER_GROUP;
	const maxBytes = options.maxFilterBytes ?? MAX_FILTER_BYTES;
	const unique = [...new Set(mailboxIds)];
	const groups: string[][] = [];
	let current: string[] = [];
	for (const id of unique) {
		const candidate = [...current, id];
		if (current.length > 0 && (candidate.length > maxIds || filterBytes(candidate) > maxBytes)) {
			groups.push(current);
			current = [id];
		} else {
			current = candidate;
		}
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

/** Vectorize vector ids must stay at most this many bytes. */
export const MAX_VECTOR_ID_BYTES = 64;

/** First 32 hex characters (128 bits) of SHA-256 of `messageId`, stored as `message_embeddings.vector_key`. */
export async function vectorKeyFor(messageId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(messageId));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 32);
}

/** `<key>:<chunk>`, always under `MAX_VECTOR_ID_BYTES` since `key` is fixed at 32 hex characters. */
export function chunkVectorId(key: string, chunk: number): string {
	return `${key}:${chunk}`;
}

/** Splits a chunk vector id back into its message key and chunk number, or null when it is not one. */
export function parseChunkVectorId(id: string): { key: string; chunk: number } | null {
	const match = /^([0-9a-f]{32}):(\d+)$/.exec(id);
	return match ? { key: match[1], chunk: Number(match[2]) } : null;
}
