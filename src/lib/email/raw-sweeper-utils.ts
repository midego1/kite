/** Where intake stores raw MIME until delivery; the only prefix the sweeper ever lists or deletes under. */
export const RAW_SWEEP_PREFIX = "inbound/";

/** The sweeper's position, a system object (always on the default store), so it needs no migration. */
export const RAW_SWEEP_STATE_KEY = "system/raw-sweep.json";

/**
 * How old an unreferenced raw object must be. Its queue message is finished long before: Cloudflare Queues retry three
 * times seconds to a minute apart, and pending self-hosted queue messages are checked separately.
 */
const RAW_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Objects listed per page and pages per run: at most 20,000 objects a day, one lookup query per 500 keys. */
export const RAW_SWEEP_PAGE_SIZE = 1000;
export const RAW_SWEEP_MAX_PAGES = 20;
export const RAW_SWEEP_LOOKUP_CHUNK = 500;

export type RawSweepState = { version: 1; after: string };

/** The stored position, or null (start at the beginning) when there is none or it is not one the sweeper wrote. */
export function parseRawSweepState(text: string | null): RawSweepState | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text) as Partial<RawSweepState>;
		return value.version === 1 && typeof value.after === "string" && value.after.startsWith(RAW_SWEEP_PREFIX)
			? { version: 1, after: value.after }
			: null;
	} catch {
		return null;
	}
}

export type RawSweepObject = { key: string; uploaded: Date };

/**
 * One listed page, in key order: the keys old enough to be judged, and whether a younger object ends the run. Intake
 * keys start with the time they were written (`inbound/<ms>-<id>.eml`), so everything after the first young object
 * is younger still, and the position never moves past an object that could still be waiting for its queue message.
 */
export function dueRawObjects(objects: RawSweepObject[], now: Date): { due: string[]; reachedYoung: boolean } {
	const due: string[] = [];
	for (const object of objects) {
		if (!object.key.startsWith(RAW_SWEEP_PREFIX)) continue;
		if (now.getTime() - object.uploaded.getTime() < RAW_SWEEP_MIN_AGE_MS) return { due, reachedYoung: true };
		due.push(object.key);
	}
	return { due, reachedYoung: false };
}

const QUEUED_RAW_KEY = /"rawR2Key"\s*:\s*"(inbound\/[^"\\]+)"/g;

/**
 * Every intake object a pending self-hosted queue message body names. Read as text rather than parsed, so a body of
 * any shape still protects the objects it names.
 */
export function queuedRawKeys(body: string): string[] {
	return [...body.matchAll(QUEUED_RAW_KEY)].map((match) => match[1]);
}
