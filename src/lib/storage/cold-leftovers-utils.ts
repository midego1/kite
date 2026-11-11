/** @public Exercised by the unit tests. Why the leftover cleanup (`cold-leftovers.ts`) kept a copy this time; each
 * is retried on a later run. */
export const LEFTOVER_KEPT_REASONS = [
	"busy",
	"confirming",
	"backup",
	"only_copy",
	"unverified",
	"cold_target",
	"migrating",
	"restore",
	"store_unavailable",
	"lease_lost",
	"error",
] as const;
export type LeftoverKeptReason = (typeof LEFTOVER_KEPT_REASONS)[number];

/** `deleted`: the copy was deleted. `cleared`: only the tracking row went (the copy is the live one again, or it
 * was already gone). Anything else kept the copy. */
export type LeftoverOutcome = "deleted" | "cleared" | LeftoverKeptReason;

export function isKeptReason(value: unknown): value is LeftoverKeptReason {
	return typeof value === "string" && (LEFTOVER_KEPT_REASONS as readonly string[]).includes(value);
}

/** Plain-words text for each kept reason, for Admin → Storage. */
export const KEPT_REASON_TEXT: Record<LeftoverKeptReason, string> = {
	busy: "a cold storage move or migration was working on the object",
	confirming: "first seen unused; waiting out the grace period before deleting it",
	backup: "a backup you keep could still restore a reference to it",
	only_copy: "no other readable copy was found",
	unverified: "its other copy could not be confirmed to hold the same bytes",
	cold_target: "a cold storage rule or sweep archives into this store and may reuse it",
	migrating: "a storage migration is using this store",
	restore: "a backup restore started while it was being checked",
	store_unavailable: "the store could not be reached",
	lease_lost: "another operation took over the object before the delete",
	error: "the check failed; it is tried again later",
};

export const DAY_SECONDS = 24 * 60 * 60;

export type LeftoverSettings = { automatic: boolean; graceDays: number };
export const DEFAULT_LEFTOVER_SETTINGS: LeftoverSettings = { automatic: false, graceDays: 7 };
export const MIN_GRACE_DAYS = 1;
export const MAX_GRACE_DAYS = 365;

export type LeftoverTrigger = "manual" | "automatic";

export type LeftoverRunSummary = {
	at: string;
	trigger: LeftoverTrigger;
	storeId: string | null;
	checked: number;
	deleted: number;
	cleared: number;
	kept: Partial<Record<LeftoverKeptReason, number>>;
	/** Set when the run did nothing at all: a restore is running, needs recovery or just finished, or the database
	 * update the cleanup needs is not applied yet. */
	skipped: "restore" | "unsupported" | null;
};

export type LeftoverState = LeftoverSettings & { lastRun: LeftoverRunSummary | null };

function isGraceDays(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= MIN_GRACE_DAYS && (value as number) <= MAX_GRACE_DAYS;
}

/** The stored JSON (`storage_state.leftover_cleanup`), defaulted field by field; never throws. */
export function parseLeftoverState(value: string | null | undefined): LeftoverState {
	let parsed: Record<string, unknown> = {};
	try {
		const raw = value ? (JSON.parse(value) as unknown) : null;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed = raw as Record<string, unknown>;
	} catch {
		parsed = {};
	}
	const lastRun = parsed.lastRun && typeof parsed.lastRun === "object" ? (parsed.lastRun as LeftoverRunSummary) : null;
	return {
		automatic: parsed.automatic === true,
		graceDays: isGraceDays(parsed.graceDays) ? parsed.graceDays : DEFAULT_LEFTOVER_SETTINGS.graceDays,
		lastRun,
	};
}

/** `{ automatic, graceDays }` from an admin request. */
export function parseLeftoverSettingsInput(
	raw: unknown,
): { ok: true; value: LeftoverSettings } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object") return { ok: false, error: "Send { automatic, graceDays }" };
	const { automatic, graceDays } = raw as Record<string, unknown>;
	if (typeof automatic !== "boolean") return { ok: false, error: "automatic must be true or false" };
	if (!isGraceDays(graceDays))
		return {
			ok: false,
			error: `The grace period is a whole number of days from ${MIN_GRACE_DAYS} to ${MAX_GRACE_DAYS}`,
		};
	return { ok: true, value: { automatic, graceDays } };
}

/** What a run's per-copy outcomes add up to. */
export function tallyOutcomes(
	outcomes: readonly LeftoverOutcome[],
): Pick<LeftoverRunSummary, "checked" | "deleted" | "cleared" | "kept"> {
	const kept: Partial<Record<LeftoverKeptReason, number>> = {};
	let deleted = 0;
	let cleared = 0;
	for (const outcome of outcomes) {
		if (outcome === "deleted") deleted += 1;
		else if (outcome === "cleared") cleared += 1;
		else kept[outcome] = (kept[outcome] ?? 0) + 1;
	}
	return { checked: outcomes.length, deleted, cleared, kept };
}

/** What the cleanup knows about one leftover under the key's lease. */
export type LeftoverFacts = {
	/** The store the leftover copy is on. */
	candidateStore: string;
	/** The store the key's location row names under the claim (the cleanup's own claim row for a key with none). */
	rowStore: string;
	/** Whether that row is the cleanup's own claim row: the key had no location row. */
	created: boolean;
	/** Whether anything live still names the key (`stillReferenced`). */
	referenced: boolean;
	/** For Drive, the store `drive_items.store_id` names, which Drive reads first; null otherwise. */
	driveRowStore: string | null;
};

/**
 * How the cleanup must treat one leftover:
 * - `live`: the copy is what a live row reads (the location of a referenced key, or Drive's own row); never deleted,
 *   only its tracking row is dropped.
 * - `only_copy`: a referenced key with no location row whose only copy found is this one; kept.
 * - `unreferenced`: nothing references the key; deletable without another copy, once no retained backup could
 *   restore a reference to it.
 * - `superseded`: another store holds the key's live copy; deletable once that copy reads back, and no retained
 *   backup could restore a location naming this one.
 */
export type LeftoverPlan =
	{ kind: "live" } | { kind: "only_copy" } | { kind: "unreferenced" } | { kind: "superseded"; otherStoreId: string };

export function planLeftover(facts: LeftoverFacts): LeftoverPlan {
	if (facts.driveRowStore === facts.candidateStore) return { kind: "live" };
	if (facts.rowStore !== facts.candidateStore) return { kind: "superseded", otherStoreId: facts.rowStore };
	if (!facts.referenced) return { kind: "unreferenced" };
	return facts.created ? { kind: "only_copy" } : { kind: "live" };
}

/**
 * Whether a restore ran since a leftover was first seen unreferenced, so that sighting no longer proves anything:
 * only a restore brings a reference back, and a key referenced again for a while after it (and then deleted
 * again) may be named by any backup taken in between. The cleanup then starts the unreferenced stretch over from
 * now, so `unreferencedSince` always starts a stretch in which no restore ran and nothing could reference the key.
 */
export function restoredSince(unreferencedSince: number, lastRestoreAt: number | null): boolean {
	return lastRestoreAt !== null && lastRestoreAt >= unreferencedSince;
}
