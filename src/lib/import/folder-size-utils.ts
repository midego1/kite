/** Messages asked for by one `FETCH n:m (UID RFC822.SIZE)`: about 40 bytes of answer line each. */
const SIZE_WINDOW_MESSAGES = 10_000;
/** One measuring step stops after this many messages, so a request stays short and its answer small. */
const SIZE_STEP_MESSAGES = 10_000;
/** A step is at most this many windows (one, with the defaults above). */
const SIZE_STEP_MAX_WINDOWS = 5;
/** A step starts no further window after this long. */
const SIZE_STEP_MAX_MS = 10_000;
/** A folder takes at most this many steps (one per 10,000 messages, so 1,000,000 messages), plus the slack below. */
const SIZE_MAX_STEPS = 100;
const SIZE_STEP_SLACK = 3;

export type SizeStepLimits = { windowMessages: number; stepMessages: number; maxWindows: number; maxMs: number };

export const DEFAULT_SIZE_STEP_LIMITS: SizeStepLimits = {
	windowMessages: SIZE_WINDOW_MESSAGES,
	stepMessages: SIZE_STEP_MESSAGES,
	maxWindows: SIZE_STEP_MAX_WINDOWS,
	maxMs: SIZE_STEP_MAX_MS,
};

export type FolderSizeStep = {
	/** Messages and bytes this step added; `unsized` of the messages came with no `RFC822.SIZE`. */
	messages: number;
	bytes: number;
	unsized: number;
	/** Where the next step goes on (the highest sequence number still to measure), or null when the folder is covered. */
	nextCursor: number | null;
	/** The folder's message count and `UIDVALIDITY` when the step ran; a changed `UIDVALIDITY` means start again. */
	exists: number;
	uidValidity: number | null;
};

/**
 * The sequence-number window a step measures next, newest first (the order an import copies in, so a partial answer
 * describes recent mail). Sequence numbers are dense, so a folder takes one window per 10,000 messages whatever its
 * UIDs look like (a mailbox with a huge `UIDNEXT` and few messages is one request). `cursor` is the highest number not
 * yet measured; null starts at the top. Null: nothing is left.
 */
export function nextSizeWindow(
	cursor: number | null,
	exists: number,
	windowMessages: number,
): { from: number; to: number } | null {
	const to = Math.min(cursor ?? exists, exists);
	if (!Number.isSafeInteger(to) || to < 1) return null;
	return { from: Math.max(1, to - Math.max(1, Math.floor(windowMessages)) + 1), to };
}

/** Messages and bytes of one answer; an entry with no `RFC822.SIZE` counts as a message and as `unsized`. */
export function sumSizes(entries: readonly { size: number | null }[]): {
	messages: number;
	bytes: number;
	unsized: number;
} {
	let bytes = 0;
	let unsized = 0;
	for (const entry of entries) {
		if (entry.size !== null && Number.isFinite(entry.size) && entry.size >= 0) bytes += entry.size;
		else unsized += 1;
	}
	return { messages: entries.length, bytes, unsized };
}

/** What a client sends back as the cursor: a sequence number, or null for the start. Anything else starts over. */
export function parseSizeCursor(value: unknown): number | null {
	const number = Number(value);
	return value === null || value === undefined || !Number.isSafeInteger(number) || number < 1 ? null : number;
}

/** The share (0 to 1) of a folder of `exists` messages covered when the next step starts at `cursor`. */
export function sizeProgress(cursor: number | null, exists: number): number {
	if (cursor === null || exists < 1) return 1;
	return Math.min(1, Math.max(0, (exists - cursor) / exists));
}

/** How many steps measuring a folder of `messages` (null: not known) may take before the page gives up on it. */
export function maxSizeSteps(messages: number | null): number {
	if (messages === null) return SIZE_MAX_STEPS;
	return Math.min(SIZE_MAX_STEPS, Math.ceil(messages / SIZE_STEP_MESSAGES) + SIZE_STEP_SLACK);
}
