const MB = 1024 * 1024;

/** Messages per UID FETCH, at most. */
const FETCH_BATCH_MESSAGES = 25;
/**
 * Bytes per UID FETCH, at most (a single message above it is fetched alone). A fetch is held in memory until it is
 * written, and a Workers isolate has 128 MB, so a batch of big messages is split instead of read together.
 */
const FETCH_BATCH_BYTES = 16 * MB;

export type FetchPlanLimits = {
	/** The largest message taken: above it the message is skipped (`ImapLimits.literalBytes`). */
	messageBytes: number;
	batchBytes?: number;
	batchMessages?: number;
};

export type OversizedMessage = { uid: string; size: number };

/**
 * One fetch that is also one unit of work: the messages are fetched, written, and only then is the next segment
 * fetched, so at most one segment (plus one being prefetched, see `canPrefetch`) is held in memory.
 */
export type FetchSegment = {
	/** Every UID the segment covers, in the order given, the oversized ones included (they count as skipped). */
	uids: string[];
	/** The UIDs to fetch: `uids` without the oversized ones. May be empty. */
	fetch: string[];
	/** The bytes the fetched messages are expected to weigh. */
	weight: number;
	/** Messages above `messageBytes`: never fetched, so one huge message cannot fail the batch. */
	oversized: OversizedMessage[];
};

/**
 * Splits `uids` into segments by their RFC822.SIZE (`sizes`, by UID), in order: messages above the cap are set aside
 * inside the segment they sit in, the rest are grouped up to `batchMessages` and `batchBytes` (a message up to the
 * cap that does not fit with the others gets a segment of its own). A UID the server gave no size for is planned as
 * if it weighed the cap, so it is fetched alone and never prefetched beside another.
 */
export function planFetchSegments(
	uids: readonly string[],
	sizes: ReadonlyMap<string, number | null>,
	limits: FetchPlanLimits,
): FetchSegment[] {
	const maxBytes = limits.batchBytes ?? FETCH_BATCH_BYTES;
	const maxMessages = limits.batchMessages ?? FETCH_BATCH_MESSAGES;
	const segments: FetchSegment[] = [];
	let current: FetchSegment | null = null;
	for (const uid of uids) {
		const size = sizes.get(uid) ?? null;
		const oversized = size !== null && size > limits.messageBytes;
		// A server that names no size is planned for the worst case, the message limit: such a message goes alone.
		const weight = oversized ? 0 : (size ?? limits.messageBytes);
		if (
			current &&
			!oversized &&
			current.fetch.length &&
			(current.fetch.length >= maxMessages || current.weight + weight > maxBytes)
		)
			current = null;
		if (!current) {
			current = { uids: [], fetch: [], weight: 0, oversized: [] };
			segments.push(current);
		}
		current.uids.push(uid);
		if (oversized) current.oversized.push({ uid, size });
		else {
			current.fetch.push(uid);
			current.weight += weight;
		}
	}
	return segments;
}

/** The most that may be fetched or waiting to be written at once: a segment and the one prefetched behind it. */
const IN_FLIGHT_BYTES = 2 * FETCH_BATCH_BYTES;

/** Whether the next segment may be fetched while the current one is written, without passing `IN_FLIGHT_BYTES`. */
export function canPrefetch(current: Pick<FetchSegment, "weight">, next: Pick<FetchSegment, "weight">): boolean {
	return current.weight + next.weight <= IN_FLIGHT_BYTES;
}

function megabytes(bytes: number): string {
	return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

/** The line a job lists for a message it left out, in plain words. */
export function oversizedNote(folder: string, message: OversizedMessage, messageBytes: number): string {
	return `${folder}: skipped message ${message.uid}, ${megabytes(message.size)} is over the ${megabytes(messageBytes)} limit`;
}
