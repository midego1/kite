import { sourcesFor, type MigrationSource } from "./migration-utils";
import type { RoutableClass } from "./types";

export const STORAGE_COLD_KIND = "storage.cold";
export type StorageColdMessage = { kind: typeof STORAGE_COLD_KIND; objectClass: RoutableClass };

export function isStorageColdMessage(payload: unknown): payload is StorageColdMessage {
	return (
		typeof payload === "object" &&
		payload !== null &&
		(payload as { kind?: unknown }).kind === STORAGE_COLD_KIND &&
		typeof (payload as { objectClass?: unknown }).objectClass === "string"
	);
}

/** The sentinel `target` that rewrites an object in place to the default store's cheaper storage class. */
export const R2_IA_TARGET = "r2-ia";
/** The R2 (and S3 `x-amz-storage-class`) value `r2-ia` writes. */
export const COLD_STORAGE_CLASS = "InfrequentAccess";

/** An admin-saved rule for one class; `target` is `R2_IA_TARGET` or a `storage_stores` id. */
export type ColdRule = { objectClass: RoutableClass; afterDays: number; minBytes: number; target: string };

/**
 * One sweep's position: the rule and the cutoff (`afterDays` resolved against the moment the sweep started, so
 * a batch processed hours or days later judges age the same way), snapshotted so an edit or the passage of time
 * mid-sweep cannot move the goalposts, plus the last row id processed per source table (`null` before the first
 * page, `"done"` once exhausted) — the same shape `src/lib/storage/migration-utils.ts` uses for a store migration.
 */
export type ColdCursor = {
	rule: ColdRule;
	/** Epoch seconds; an object created at or before this is old enough. */
	cutoffAt: number;
	sources: Partial<Record<MigrationSource, string | null>>;
	leaseUntil?: number;
	lastBatchAt?: number;
	failures?: number;
};

const DONE = "done";

/** The point an object must be created at or before to be old enough for `afterDays`. */
function coldCutoff(afterDays: number, now: Date): Date {
	return new Date(now.getTime() - afterDays * 24 * 60 * 60 * 1000);
}

export function initialColdCursor(rule: ColdRule, now: Date): ColdCursor {
	return {
		rule,
		cutoffAt: Math.floor(coldCutoff(rule.afterDays, now).getTime() / 1000),
		sources: Object.fromEntries(sourcesFor(rule.objectClass).map((source) => [source, null])),
	};
}

/** Throws on a damaged cursor; the job row always holds one this module wrote. */
export function parseColdCursor(value: string | null): ColdCursor {
	const parsed = JSON.parse(value ?? "") as ColdCursor;
	if (!parsed || typeof parsed !== "object" || !parsed.rule || !parsed.sources) throw new Error("Damaged cursor");
	return parsed;
}

/** The source the sweep works on next, or null once every source is exhausted. */
export function nextColdSource(cursor: ColdCursor): MigrationSource | null {
	return sourcesFor(cursor.rule.objectClass).find((source) => cursor.sources[source] !== DONE) ?? null;
}

/** Moves the cursor past one page; a page that ended the source marks it done. */
export function advanceColdCursor(
	cursor: ColdCursor,
	source: MigrationSource,
	lastId: string | null,
	exhausted: boolean,
): ColdCursor {
	return { ...cursor, sources: { ...cursor.sources, [source]: exhausted ? DONE : lastId } };
}

/**
 * Candidates eligible to move now: created at or before `cutoff`, and at or above the size floor. A `null`
 * size (raw mail has none recorded in D1) always passes the floor; age alone decides for it.
 */
export function selectColdCandidates<T extends { size: number | null; createdAt: Date }>(
	rule: Pick<ColdRule, "minBytes">,
	cutoff: Date,
	items: readonly T[],
): T[] {
	return items.filter(
		(item) => item.createdAt.getTime() <= cutoff.getTime() && (item.size ?? rule.minBytes) >= rule.minBytes,
	);
}
