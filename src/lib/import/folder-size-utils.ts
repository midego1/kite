/** UIDs asked for by one `UID FETCH n:m (UID RFC822.SIZE)`: at most this many answer lines of about 40 bytes. */
const SIZE_WINDOW_UIDS = 10_000;
/** One measuring step stops after this many messages, so a request stays short and its answer small. */
const SIZE_STEP_MESSAGES = 10_000;
/** A sparse folder (many expunged UIDs) answers few messages per window; a step still ends after this many windows. */
const SIZE_STEP_MAX_WINDOWS = 50;
/** A step starts no further window after this long. */
const SIZE_STEP_MAX_MS = 10_000;

export type SizeStepLimits = {
	windowUids: number;
	stepMessages: number;
	maxWindows: number;
	maxMs: number;
	maxFolderUids?: number;
};

export const DEFAULT_SIZE_STEP_LIMITS: SizeStepLimits = {
	windowUids: SIZE_WINDOW_UIDS,
	stepMessages: SIZE_STEP_MESSAGES,
	maxWindows: SIZE_STEP_MAX_WINDOWS,
	maxMs: SIZE_STEP_MAX_MS,
};

export type FolderSizeStep = {
	/** Messages and bytes this step added. */
	messages: number;
	bytes: number;
	/** Where the next step goes on (the highest UID still to measure), or null when the folder is covered. */
	nextCursor: number | null;
	/** The folder's `UIDNEXT`: the first step's cursor is just below it, so `uidNext - 1 - nextCursor` UIDs are covered. */
	uidNext: number;
	uidValidity: number | null;
	/** A changed UID namespace discarded the caller's cursor; discard earlier sums too. */
	reset: boolean;
};

/**
 * The UID window a step measures next, newest first (the order an import copies in, so a partial answer describes
 * recent mail). `cursor` is the highest UID not yet measured; null starts below `uidNext`. Null: nothing is left.
 */
export function nextSizeWindow(
	cursor: number | null,
	uidNext: number,
	windowUids: number,
): { from: number; to: number } | null {
	const to = Math.min(cursor ?? uidNext - 1, uidNext - 1);
	if (!Number.isSafeInteger(to) || to < 1) return null;
	return { from: Math.max(1, to - Math.max(1, Math.floor(windowUids)) + 1), to };
}

/** Messages and bytes of one answer; an entry with no `RFC822.SIZE` counts as a message without weight. */
export function sumSizes(entries: readonly { size: number | null }[]): { messages: number; bytes: number } {
	let bytes = 0;
	for (const entry of entries)
		if (entry.size !== null && Number.isFinite(entry.size) && entry.size > 0) bytes += entry.size;
	return { messages: entries.length, bytes };
}

/** What a client sends back as the cursor: a UID, or null for the start. Anything else starts over. */
export function parseSizeCursor(value: unknown): number | null {
	const number = Number(value);
	return value === null || value === undefined || !Number.isSafeInteger(number) || number < 1 ? null : number;
}

/** The share (0 to 1) of a folder's UID range covered when the next step starts at `cursor`. */
export function sizeProgress(cursor: number | null, uidNext: number): number {
	if (cursor === null) return 1;
	const total = uidNext - 1;
	return total < 1 ? 1 : Math.min(1, Math.max(0, (total - cursor) / total));
}
