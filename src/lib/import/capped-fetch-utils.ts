const MB = 1024 * 1024;

/** Messages per UID FETCH, at most. */
const FETCH_BATCH_MESSAGES = 25;
/**
 * Bytes per UID FETCH, at most (a single message above it is fetched alone). A fetch is held in memory until it is
 * written, and a Workers isolate has 128 MB, so a batch of big messages is split instead of read together.
 */
const FETCH_BATCH_BYTES = 16 * MB;
/** What a message whose server named no RFC822.SIZE is assumed to weigh when batches are planned. */
const UNKNOWN_SIZE_BYTES = 1 * MB;

export type FetchPlanLimits = {
	/** The largest message taken: above it the message is skipped (`ImapLimits.literalBytes`). */
	messageBytes: number;
	batchBytes?: number;
	batchMessages?: number;
};

export type OversizedMessage = { uid: string; size: number };

export type FetchPlan = {
	/** The UIDs to fetch, in the order given, grouped so no group is above the message or byte limits. */
	batches: string[][];
	/** Messages above `messageBytes`: never fetched, so a batch is not lost to one huge message. */
	oversized: OversizedMessage[];
};

/**
 * Splits `uids` into fetches by their RFC822.SIZE (`sizes`, by UID): messages above the cap are set aside, the rest are
 * grouped up to `batchMessages` and `batchBytes`. A UID the server gave no size for is fetched as if it weighed 1 MB.
 */
export function planFetchBatches(
	uids: readonly string[],
	sizes: ReadonlyMap<string, number | null>,
	limits: FetchPlanLimits,
): FetchPlan {
	const maxBytes = limits.batchBytes ?? FETCH_BATCH_BYTES;
	const maxMessages = limits.batchMessages ?? FETCH_BATCH_MESSAGES;
	const batches: string[][] = [];
	const oversized: OversizedMessage[] = [];
	let current: string[] = [];
	let currentBytes = 0;
	for (const uid of uids) {
		const size = sizes.get(uid) ?? null;
		if (size !== null && size > limits.messageBytes) {
			oversized.push({ uid, size });
			continue;
		}
		const weight = size ?? UNKNOWN_SIZE_BYTES;
		if (current.length && (current.length >= maxMessages || currentBytes + weight > maxBytes)) {
			batches.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(uid);
		currentBytes += weight;
	}
	if (current.length) batches.push(current);
	return { batches, oversized };
}

function megabytes(bytes: number): string {
	return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

/** The line a job lists for a message it left out, in plain words. */
export function oversizedNote(folder: string, message: OversizedMessage, messageBytes: number): string {
	return `${folder}: skipped message ${message.uid}, ${megabytes(message.size)} is over the ${megabytes(messageBytes)} limit`;
}
