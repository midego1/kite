import type { RoutableClass } from "./types";

/** One queue message copies at most this many objects or bytes, then re-enqueues itself. */
export const MAX_BATCH_OBJECTS = 50;
/** @public Exercised by the unit tests. */
export const MAX_BATCH_BYTES = 256 * 1024 * 1024;
/** Objects larger than this are copied as multipart uploads of this part size. */
export const MULTIPART_COPY_THRESHOLD = 64 * 1024 * 1024;
export const COPY_PART_BYTES = 64 * 1024 * 1024;
/** A batch holds the job this long; a stalled job is restarted by the 5-minute cron after it lapses. */
export const LEASE_MS = 10 * 60 * 1000;
/** A completed migration keeps the old store in the read chain this long, then finishes by itself. */
export const AUTO_FINISH_MS = 7 * 24 * 60 * 60 * 1000;
/** A store must have passed validation this recently to become a route's target. */
export const VALIDATION_FRESH_MS = 60 * 60 * 1000;

export const STORAGE_MIGRATE_KIND = "storage.migrate";
export type StorageMigrateMessage = { kind: typeof STORAGE_MIGRATE_KIND; jobId: string };

export function isStorageMigrateMessage(payload: unknown): payload is StorageMigrateMessage {
	return (
		typeof payload === "object" &&
		payload !== null &&
		(payload as { kind?: unknown }).kind === STORAGE_MIGRATE_KIND &&
		typeof (payload as { jobId?: unknown }).jobId === "string"
	);
}

export type MigrationSource = "messages" | "attachments" | "drive" | "backups";
/** `copy` moves every object; `verify` checks each on the target and copies what is missing; `purge` deletes the source copies. */
export type MigrationPhase = "copy" | "verify" | "done" | "purge" | "purged";

export type MigrationCursor = {
	phase: MigrationPhase;
	/** Per source: the last row id processed, `null` before the first page, `"done"` once exhausted. */
	sources: Partial<Record<MigrationSource, string | null>>;
	/** Drive's verify pass has two halves: rows already on the target, then rows still naming the source. */
	driveLeftovers?: boolean;
	leaseUntil?: number;
	lastBatchAt?: number;
};

const DONE = "done";

/**
 * The tables keys come from, per class; keys always come from D1, never from listing a bucket.
 * @public Exercised by the unit tests.
 */
export function sourcesFor(objectClass: RoutableClass): MigrationSource[] {
	if (objectClass === "mail") return ["messages", "attachments"];
	if (objectClass === "drive") return ["drive"];
	return ["backups"];
}

export function initialCursor(objectClass: RoutableClass, phase: MigrationPhase = "copy"): MigrationCursor {
	return { phase, sources: Object.fromEntries(sourcesFor(objectClass).map((source) => [source, null])) };
}

export function parseCursor(value: string | null, objectClass: RoutableClass): MigrationCursor {
	try {
		const parsed = JSON.parse(value ?? "") as MigrationCursor;
		if (parsed && typeof parsed === "object" && typeof parsed.phase === "string" && parsed.sources) return parsed;
	} catch {
		// A missing or damaged cursor starts the copy again, which is safe: copies are idempotent.
	}
	return initialCursor(objectClass);
}

/** The source the current phase works on next, or null when the phase is through. */
export function nextSource(cursor: MigrationCursor, objectClass: RoutableClass): MigrationSource | null {
	return sourcesFor(objectClass).find((source) => cursor.sources[source] !== DONE) ?? null;
}

/** Moves the cursor past one page; a page that ended the source marks it done. */
export function advance(
	cursor: MigrationCursor,
	source: MigrationSource,
	lastId: string | null,
	exhausted: boolean,
): MigrationCursor {
	return { ...cursor, sources: { ...cursor.sources, [source]: exhausted ? DONE : lastId } };
}

/** The phase after this one; `done` and `purged` are final. */
export function nextPhase(cursor: MigrationCursor, objectClass: RoutableClass): MigrationCursor {
	if (cursor.phase === "copy") return { ...initialCursor(objectClass, "verify"), driveLeftovers: false };
	if (cursor.phase === "purge") return { ...cursor, phase: "purged" };
	return { ...cursor, phase: "done" };
}

/**
 * The leading objects of a page that fit one batch: at most `MAX_BATCH_OBJECTS`, and stopping before the byte
 * budget is exceeded, though always at least one so a single huge object still moves. Unknown sizes count as 0
 * here; the copy adds the real size.
 */
export function takeBatch<T extends { size?: number | null }>(
	objects: readonly T[],
	limits = { objects: MAX_BATCH_OBJECTS, bytes: MAX_BATCH_BYTES },
): T[] {
	const batch: T[] = [];
	let bytes = 0;
	for (const object of objects) {
		if (batch.length >= limits.objects) break;
		const size = object.size ?? 0;
		if (batch.length && bytes + size > limits.bytes) break;
		batch.push(object);
		bytes += size;
	}
	return batch;
}

/** Byte ranges of a multipart copy. */
export function copyParts(
	size: number,
	partBytes = COPY_PART_BYTES,
): { partNumber: number; offset: number; length: number }[] {
	const parts = [];
	for (let offset = 0, partNumber = 1; offset < size; offset += partBytes, partNumber += 1)
		parts.push({ partNumber, offset, length: Math.min(partBytes, size - offset) });
	return parts;
}

export function isLeased(cursor: MigrationCursor, now: number): boolean {
	return !!cursor.leaseUntil && cursor.leaseUntil > now;
}

/** True when a running job has not finished a batch for a while and nobody holds it. */
export function isStalled(cursor: MigrationCursor, now: number, startedAt: number | null): boolean {
	if (isLeased(cursor, now)) return false;
	const last = cursor.lastBatchAt ?? startedAt ?? 0;
	return now - last >= 5 * 60 * 1000;
}

export const ACTIVE_MIGRATION_STATUSES = ["queued", "copying", "verifying"] as const;

export function isActiveMigration(status: string): boolean {
	return (ACTIVE_MIGRATION_STATUSES as readonly string[]).includes(status);
}

/** The words a purge must be confirmed with: the old store's name, as the admin sees it. */
export function purgeConfirmationMatches(typed: unknown, storeName: string): boolean {
	return typeof typed === "string" && typed.trim().toLowerCase() === storeName.trim().toLowerCase();
}
