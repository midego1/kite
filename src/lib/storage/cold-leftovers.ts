import { readRestoreJob } from "@/lib/backups/restore-job-store";
import { isActiveRestore } from "@/lib/backups/restore-job-utils";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { createHash } from "node:crypto";
import { createLogger } from "@/lib/logger.mjs";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { RESTORE_COOLDOWN_MS, stillReferenced } from "./cold-orphans";
import {
	DAY_SECONDS,
	isKeptReason,
	planLeftover,
	restoredSince,
	tallyOutcomes,
	type LeftoverKeptReason,
	type LeftoverOutcome,
	type LeftoverRunSummary,
	type LeftoverTrigger,
} from "./cold-leftovers-utils";
import { countTracked, readLeftoverState, writeLastRun } from "./cold-leftovers-state";
import { parseColdCursor } from "./cold-utils";
import { DEFAULT_STORE_ID, isRoutableClass } from "./config-utils";
import { getStorage, type StoragePlatformEnv } from "./index";
import { ACTIVE_MIGRATION_STATUSES, parseCursor } from "./migration-utils";
import {
	claimKeyForLeftover,
	confirmLeftoverClaim,
	dropCandidateUnderClaim,
	dropLocationUnderClaim,
	endLeftoverClaim,
	type LeftoverClaim,
} from "./object-locations";
import { driveItemIdFromObjectKey } from "./object-classes-utils";
import type { ObjectStore, RoutableClass, Storage } from "./types";

const log = createLogger("storage");

type LeftoverEnv = StoragePlatformEnv;

/** Copies one manual "Delete leftovers" request settles: up to about twenty D1 statements and object calls each,
 * inside a Worker request's subrequest limit. The response says how many are left for another click. */
const MANUAL_LEFTOVER_LIMIT = 50;
/** Copies one five-minute maintenance run settles when the automatic cleanup is on. */
const AUTOMATIC_LEFTOVER_LIMIT = 25;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
/** Claims whose object delete threw: not ended, so they run out at the expiry the confirm set (`B1`). */
const claimsHeldToExpiry = new WeakSet<LeftoverClaim>();
/** How long after its final check (`confirmLeftoverClaim`, which extends the claim to 15 minutes) a delete may still
 * be issued, and how long that delete may take: both far inside the claim, so a stalled cleanup gives up instead of
 * deleting a copy another deleter may by then have relied on (review of #479, `M1`). */
const CONFIRM_TO_DELETE_MS = 30_000;
const DELETE_TIMEOUT_MS = 30_000;
/** Objects up to this size are compared byte for byte (SHA-256) when their ETags do not already match. */
const HASH_COMPARE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Whether a restore keeps the cleanup off entirely, and when the last one ended. A restore empties and rewrites
 * the tables that reference objects, so while one runs, needs recovery (its rollback never finished), has just
 * finished, or a backup's mail files are being restored, an object can look unreferenced that is not. The newest
 * safety backup counts as a restore too, in case the job record itself is gone.
 */
async function restoreGate(env: LeftoverEnv, now: Date): Promise<{ blocked: boolean; lastRestoreAt: number | null }> {
	const stored = await readRestoreJob(env.BUCKET);
	const job = stored?.job;
	if (job && (isActiveRestore(job) || job.needsRecovery)) return { blocked: true, lastRestoreAt: null };
	const ended = job ? Date.parse(job.finishedAt ?? job.updatedAt) : NaN;
	if (job && (!Number.isFinite(ended) || now.getTime() - ended < RESTORE_COOLDOWN_MS))
		return { blocked: true, lastRestoreAt: null };
	if (await backupObjectsRestoring(env)) return { blocked: true, lastRestoreAt: null };
	const safety = await env.DB.prepare(
		"SELECT max(created_at) AS at FROM backups WHERE `trigger` = 'pre-restore'",
	).first<{
		at: number | null;
	}>();
	const lastRestoreAt = Math.max(Number.isFinite(ended) ? Math.floor(ended / 1000) : 0, safety?.at ?? 0);
	return { blocked: false, lastRestoreAt: lastRestoreAt || null };
}

async function backupObjectsRestoring(env: LeftoverEnv): Promise<boolean> {
	try {
		const row = await env.DB.prepare(
			"SELECT 1 AS found FROM backups WHERE objects_status = 'restoring' LIMIT 1",
		).first<{
			found: number;
		}>();
		return !!row;
	} catch (error) {
		if (missingColumnFromError(error) === "objects_status") return false;
		throw error;
	}
}

/**
 * Whether a backup that is kept (completed) or may still complete (queued or running) could hold a reference this
 * copy is needed for: one created before `until` and not completed before `from` (null: no lower bound). Safety
 * backups (`pre-restore`) and pre-migration backups are backups like any other here.
 */
async function backupCouldHold(env: LeftoverEnv, from: number | null, until: number): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT 1 AS found FROM backups WHERE status IN ('completed', 'queued', 'running') AND created_at <= ?
		 AND (? IS NULL OR completed_at IS NULL OR completed_at >= ?) LIMIT 1`,
	)
		.bind(until, from, from)
		.first<{ found: number }>();
	return !!row;
}

/** Stores a cold move may write to right now or soon: enabled rules' targets and in-flight sweeps' targets. */
async function coldTargetStores(env: LeftoverEnv): Promise<Set<string>> {
	const targets = new Set<string>();
	try {
		const rules = await env.DB.prepare("SELECT target FROM storage_cold_rules WHERE enabled = 1").all<{
			target: string;
		}>();
		for (const rule of rules.results ?? []) targets.add(rule.target);
		const jobs = await env.DB.prepare(
			"SELECT cursor FROM storage_cold_jobs WHERE status IN ('queued', 'running')",
		).all<{ cursor: string | null }>();
		for (const job of jobs.results ?? []) {
			try {
				targets.add(parseColdCursor(job.cursor).rule.target);
			} catch {
				continue;
			}
		}
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
	}
	return targets;
}

/** Stores a storage migration is copying between, or whose old copies its purge is deleting. */
async function migratingStores(env: LeftoverEnv): Promise<Set<string>> {
	const stores = new Set<string>();
	try {
		const jobs = await env.DB.prepare(
			"SELECT object_class, from_store_id, to_store_id, status, cursor FROM storage_migrations WHERE status <> 'cancelled'",
		).all<{
			object_class: string;
			from_store_id: string;
			to_store_id: string;
			status: string;
			cursor: string | null;
		}>();
		for (const job of jobs.results ?? []) {
			const active = (ACTIVE_MIGRATION_STATUSES as readonly string[]).includes(job.status);
			const purging =
				job.status === "completed" &&
				isRoutableClass(job.object_class) &&
				parseCursor(job.cursor, job.object_class).phase === "purge";
			if (!active && !purging) continue;
			stores.add(job.from_store_id);
			stores.add(job.to_store_id);
		}
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
	}
	return stores;
}

type Candidate = {
	id: string;
	key: string;
	objectClass: RoutableClass;
	storeId: string;
	movedAt: number;
	firstOrphanedAt: number;
	unreferencedSince: number | null;
};

type CandidateRow = {
	id: string;
	key: string;
	object_class: string;
	store_id: string;
	moved_at: number;
	first_orphaned_at: number;
	unreferenced_since: number | null;
};

/** Leftovers past the grace period (counted from when each was first marked, never from a deferral), the least
 * recently looked at first, so a copy kept for a reason never blocks the rest. */
async function eligibleCandidates(
	env: LeftoverEnv,
	options: { storeId: string | null; until: number; limit: number },
): Promise<Candidate[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, key, object_class, store_id, moved_at, first_orphaned_at, unreferenced_since FROM storage_cold_orphans
		 WHERE first_orphaned_at <= ? AND (? IS NULL OR store_id = ?) ORDER BY orphaned_at, id LIMIT ?`,
	)
		.bind(options.until, options.storeId, options.storeId, options.limit)
		.all<CandidateRow>();
	return (results ?? []).flatMap((row) =>
		isRoutableClass(row.object_class)
			? [
					{
						id: row.id,
						key: row.key,
						objectClass: row.object_class,
						storeId: row.store_id,
						movedAt: row.moved_at,
						firstOrphanedAt: row.first_orphaned_at,
						unreferencedSince: row.unreferenced_since,
					},
				]
			: [],
	);
}

/** Moves a kept leftover to the back of the queue and records why, for Admin → Storage. */
async function recordKept(env: LeftoverEnv, id: string, reason: LeftoverKeptReason, now: Date): Promise<void> {
	await env.DB.prepare("UPDATE storage_cold_orphans SET orphaned_at = ?, kept_reason = ? WHERE id = ?")
		.bind(seconds(now), reason, id)
		.run();
}

/** The store Drive's own row names for a Drive key, which Drive reads before anything else. */
async function driveRowStore(env: LeftoverEnv, key: string): Promise<string | null> {
	const id = driveItemIdFromObjectKey(key);
	if (!id) return null;
	const row = await env.DB.prepare("SELECT store_id FROM drive_items WHERE id = ? AND object_key = ?")
		.bind(id, key)
		.first<{ store_id: string | null }>();
	// Drive reads a row without a store from the default store (`drive/objects.ts`).
	return row ? (row.store_id ?? DEFAULT_STORE_ID) : null;
}

/** For a key with no location row: a store a reader finds the key on without one (Drive's own row's store, then
 * the class's read chain and the default store), other than the leftover's own, by HEAD. */
async function findReadableCopy(
	storage: Storage,
	candidate: Candidate,
	driveStore: string | null,
): Promise<{ storeId: string; size: number } | null> {
	const driveRowCopy = driveStore ? storage.store(driveStore) : null;
	const stores = [driveRowCopy, ...storage.readChain(candidate.objectClass), storage.store(DEFAULT_STORE_ID)];
	const seen = new Set<string>([candidate.storeId]);
	for (const store of stores) {
		if (!store || seen.has(store.id)) continue;
		seen.add(store.id);
		const head = await store.bucket.head(candidate.key);
		if (head) return { storeId: store.id, size: head.size };
	}
	return null;
}

type Context = {
	env: LeftoverEnv;
	storage: Storage;
	now: Date;
	graceSeconds: number;
	lastRestoreAt: number | null;
	coldTargets: Set<string>;
	migrating: Set<string>;
};

/**
 * What the run checked once at its start, checked again right before a delete, since a run can take a while: a
 * restore that started (or ended) since, a cold rule or sweep that now archives into the leftover's store (only
 * for a superseded copy: a move onto that store reuses it), or a storage migration that now uses that store.
 */
async function changedSinceStart(
	context: Context,
	candidate: Candidate,
	superseded: boolean,
): Promise<LeftoverKeptReason | null> {
	const gate = await restoreGate(context.env, context.now);
	if (gate.blocked || (gate.lastRestoreAt ?? 0) > (context.lastRestoreAt ?? 0)) return "restore";
	if (superseded && (await coldTargetStores(context.env)).has(candidate.storeId)) return "cold_target";
	if ((await migratingStores(context.env)).has(candidate.storeId)) return "migrating";
	return null;
}

/**
 * The delete itself, only while holding the key's lease: after the run's own checks are repeated
 * (`changedSinceStart`), the claim is re-confirmed in the statement right before the object delete (still the
 * row's, unexpired, still naming the same store), and the tracking row (and, for an unreferenced key, its
 * location row) is dropped afterwards only while the claim still holds, in the same statement. A crash after the
 * object delete leaves a tracking row for a copy that is gone, which the next run clears.
 */
async function deleteUnderClaim(
	context: Context,
	store: ObjectStore,
	candidate: Candidate,
	claim: LeftoverClaim,
	{ superseded, dropLocation }: { superseded: boolean; dropLocation: boolean },
): Promise<LeftoverOutcome> {
	const { env } = context;
	const changed = await changedSinceStart(context, candidate, superseded);
	if (changed) return changed;
	// Timed from before the confirm is sent: a cleanup that stalled after it gives up rather than delete a copy a
	// second cleanup or a mover may since have relied on (the claim it extended outlasts both limits by far).
	const confirmedFrom = Date.now();
	if (!(await confirmLeftoverClaim(env, candidate.key, claim))) return "lease_lost";
	if (Date.now() - confirmedFrom > CONFIRM_TO_DELETE_MS) return "lease_lost";
	// A store's own client honours the deadline; the R2 binding and the Node file bucket ignore the option.
	try {
		await (store.bucket as { delete(key: string, options?: { timeoutMs?: number }): Promise<void> }).delete(
			candidate.key,
			{ timeoutMs: DELETE_TIMEOUT_MS },
		);
	} catch (error) {
		// A delete that timed out or failed may still land later (an abort is only the client giving up), so the
		// key stays claimed until the 15-minute expiry the confirm set, instead of being handed to the next deleter
		// right away, which would rely on this copy (review 2 of #479, `B1`).
		claimsHeldToExpiry.add(claim);
		throw error;
	}
	const dropped = await dropCandidateUnderClaim(env, candidate.id, candidate.key, claim);
	if (dropped && dropLocation) await dropLocationUnderClaim(env, candidate.key, claim);
	log.info("storage.cold_leftover_deleted", {
		storeId: candidate.storeId,
		objectClass: candidate.objectClass,
		unreferenced: !superseded,
	});
	return "deleted";
}

/** A single-part MD5 ETag (32 hex digits, no `-N` part count), the only form that is the object's own digest. */
function md5Etag(head: { etag?: string | null }): string | null {
	const etag = (head.etag ?? "").replace(/^W\//, "").replace(/"/g, "").trim().toLowerCase();
	return /^[0-9a-f]{32}$/.test(etag) ? etag : null;
}

/** The SHA-256 of an object, streamed, or null when it is missing, has no body or turns out larger than `limit`. */
async function sha256Of(store: ObjectStore, key: string, limit: number): Promise<string | null> {
	const object = await store.bucket.get(key);
	if (!object || !("body" in object) || !object.body || object.size > limit) return null;
	const hash = createHash("sha256");
	let read = 0;
	const reader = (object.body as ReadableStream<Uint8Array>).getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			read += value.byteLength;
			if (read > limit) return null;
			hash.update(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return hash.digest("hex");
}

/**
 * Whether the live copy holds the leftover's bytes, not just as many of them (review of #479, `m2`): equal ETags
 * that are both single-part MD5s, or else, for an object small enough, equal SHA-256 digests of both, streamed. Anything that cannot be confirmed keeps the leftover (`unverified`).
 */
async function sameBytes(
	store: ObjectStore,
	other: ObjectStore,
	key: string,
	own: { etag?: string | null; size: number },
	copy: { etag?: string | null; size: number },
): Promise<boolean> {
	const ownMd5 = md5Etag(own);
	if (ownMd5 && ownMd5 === md5Etag(copy)) return true;
	if (own.size > HASH_COMPARE_MAX_BYTES) return false;
	const [mine, theirs] = await Promise.all([
		sha256Of(store, key, HASH_COMPARE_MAX_BYTES),
		sha256Of(other, key, HASH_COMPARE_MAX_BYTES),
	]);
	return !!mine && mine === theirs;
}

/** A leftover of a key nothing references: no other copy needed, but no retained backup may hold a reference. */
async function settleUnreferenced(
	context: Context,
	store: ObjectStore,
	candidate: Candidate,
	claim: LeftoverClaim,
): Promise<LeftoverOutcome> {
	const { env, now } = context;
	// The stretch in which nothing could reference the key starts at the first sighting after the last restore.
	if (candidate.unreferencedSince === null || restoredSince(candidate.unreferencedSince, context.lastRestoreAt)) {
		await env.DB.prepare("UPDATE storage_cold_orphans SET unreferenced_since = ? WHERE id = ?")
			.bind(seconds(now), candidate.id)
			.run();
		return "confirming";
	}
	const start = candidate.unreferencedSince;
	if (seconds(now) - start < context.graceSeconds) return "confirming";
	if (await backupCouldHold(env, null, start)) return "backup";
	if (!(await store.bucket.head(candidate.key))) {
		if (await dropCandidateUnderClaim(env, candidate.id, candidate.key, claim))
			if (!claim.created) await dropLocationUnderClaim(env, candidate.key, claim);
		return "cleared";
	}
	return await deleteUnderClaim(context, store, candidate, claim, { superseded: false, dropLocation: !claim.created });
}

/** A copy superseded by the one on `otherStoreId`: deleted only once that copy reads back with the same size. */
async function settleSuperseded(
	context: Context,
	store: ObjectStore,
	candidate: Candidate,
	claim: LeftoverClaim,
	otherStoreId: string,
): Promise<LeftoverOutcome> {
	const { env, storage } = context;
	if (await backupCouldHold(env, candidate.movedAt, candidate.firstOrphanedAt)) return "backup";
	// A rule or sweep archiving into this store may move the object back onto it at any time, reusing this copy.
	if (context.coldTargets.has(candidate.storeId)) return "cold_target";
	const own = await store.bucket.head(candidate.key);
	if (!own) {
		await dropCandidateUnderClaim(env, candidate.id, candidate.key, claim);
		return "cleared";
	}
	const other = storage.store(otherStoreId);
	const copy = other ? await other.bucket.head(candidate.key) : null;
	if (!copy || copy.size !== own.size) return "only_copy";
	if (!(await sameBytes(store, other!, candidate.key, own, copy))) return "unverified";
	return await deleteUnderClaim(context, store, candidate, claim, { superseded: true, dropLocation: false });
}

async function settleUnderClaim(
	context: Context,
	store: ObjectStore,
	candidate: Candidate,
	claim: LeftoverClaim,
	driveStore: string | null,
): Promise<LeftoverOutcome> {
	const { env } = context;
	const tracked = await env.DB.prepare("SELECT 1 AS found FROM storage_cold_orphans WHERE id = ?")
		.bind(candidate.id)
		.first<{ found: number }>();
	if (!tracked) return "cleared";
	// Drive's row may have moved between the read the claim's `locate` used and the claim itself.
	if (candidate.objectClass === "drive" && (await driveRowStore(env, candidate.key)) !== driveStore) return "busy";
	const referenced = await stillReferenced(env, candidate.objectClass, candidate.key);
	// Seen referenced: whatever stretch an earlier sighting started is over.
	if (referenced && candidate.unreferencedSince !== null) {
		await env.DB.prepare("UPDATE storage_cold_orphans SET unreferenced_since = NULL WHERE id = ?")
			.bind(candidate.id)
			.run();
		candidate = { ...candidate, unreferencedSince: null };
	}
	const plan = planLeftover({
		candidateStore: candidate.storeId,
		rowStore: claim.storeId,
		created: claim.created,
		referenced,
		driveRowStore: driveStore,
	});
	if (plan.kind === "live") {
		await dropCandidateUnderClaim(env, candidate.id, candidate.key, claim);
		return "cleared";
	}
	if (plan.kind === "only_copy") {
		log.warn("storage.cold_leftover_only_copy", { storeId: candidate.storeId, objectClass: candidate.objectClass });
		return "only_copy";
	}
	if (plan.kind === "unreferenced") return await settleUnreferenced(context, store, candidate, claim);
	return await settleSuperseded(context, store, candidate, claim, plan.otherStoreId);
}

/** Decides and, when every rule allows it, deletes one leftover copy, holding the key's location lease throughout. */
async function settleLeftover(context: Context, candidate: Candidate): Promise<LeftoverOutcome> {
	const { env, storage } = context;
	if (context.migrating.has(candidate.storeId)) return "migrating";
	const store = storage.store(candidate.storeId);
	if (!store) return "store_unavailable";
	const driveStore = candidate.objectClass === "drive" ? await driveRowStore(env, candidate.key) : null;
	const claim = await claimKeyForLeftover(
		env,
		candidate.key,
		candidate.objectClass,
		async () => (await findReadableCopy(storage, candidate, driveStore)) ?? { storeId: candidate.storeId, size: 0 },
		// Leases run on the real clock, like every mover's and purge's; `now` only decides grace and backup windows.
		new Date(),
	);
	if (claim === "busy" || claim === "unsupported") return "busy";
	try {
		return await settleUnderClaim(context, store, candidate, claim, driveStore);
	} finally {
		if (!claimsHeldToExpiry.has(claim)) await endLeftoverClaim(env, candidate.key, claim);
	}
}

export type LeftoverRunResult = LeftoverRunSummary & { remaining: number };

/**
 * @public Exercised by the unit tests, which drive it with their own clock.
 * One bounded cleanup pass over leftovers past the grace period, for one store or all: the manual "Delete
 * leftovers" action and the optional automatic cleanup both run this. Every copy is settled under its key's
 * location lease (`settleLeftover`), and the whole pass is skipped while a restore could make an object look
 * unreferenced. A copy any rule forbids deleting is kept (cost only), with its reason recorded and logged.
 */
export async function purgeLeftovers(
	env: LeftoverEnv,
	options: { trigger: LeftoverTrigger; storeId?: string | null; limit: number; now?: Date },
): Promise<LeftoverRunResult> {
	const now = options.now ?? new Date();
	const storeId = options.storeId ?? null;
	const base = { at: now.toISOString(), trigger: options.trigger, storeId };
	const empty = { checked: 0, deleted: 0, cleared: 0, kept: {} };
	const state = await readLeftoverState(env);
	if (!state.available)
		return { ...base, ...empty, skipped: "unsupported", remaining: await countTracked(env, storeId) };
	const gate = await restoreGate(env, now);
	if (gate.blocked) {
		const summary: LeftoverRunSummary = { ...base, ...empty, skipped: "restore" };
		if (options.trigger === "manual") await writeLastRun(env, summary);
		return { ...summary, remaining: await countTracked(env, storeId) };
	}
	const graceSeconds = state.graceDays * DAY_SECONDS;
	const candidates = await eligibleCandidates(env, {
		storeId,
		until: seconds(now) - graceSeconds,
		limit: options.limit,
	});
	const context: Context = {
		env,
		storage: await getStorage(env),
		now,
		graceSeconds,
		lastRestoreAt: gate.lastRestoreAt,
		coldTargets: await coldTargetStores(env),
		migrating: await migratingStores(env),
	};
	const outcomes: LeftoverOutcome[] = [];
	for (const candidate of candidates) {
		let outcome: LeftoverOutcome;
		try {
			outcome = await settleLeftover(context, candidate);
		} catch (error) {
			log.warn("storage.cold_leftover_failed", { storeId: candidate.storeId, error });
			outcome = "error";
		}
		outcomes.push(outcome);
		if (isKeptReason(outcome)) await recordKept(env, candidate.id, outcome, now);
	}
	const summary: LeftoverRunSummary = { ...base, ...tallyOutcomes(outcomes), skipped: null };
	if (Object.keys(summary.kept).length) log.info("storage.cold_leftovers_kept", { kept: summary.kept, storeId });
	// An automatic pass with nothing to look at leaves the last real run on show.
	if (options.trigger === "manual" || summary.checked) await writeLastRun(env, summary);
	return { ...summary, remaining: await countTracked(env, storeId) };
}

export type DeleteLeftoversResult =
	{ ok: true; run: LeftoverRunResult } | { ok: false; status: number; error: string; code?: string };

/** The manual "Delete leftovers" action: one bounded pass over one store (`{ storeId }`, the default store
 * included) or all of them, audited with what it deleted and kept. */
export async function deleteLeftovers(env: LeftoverEnv, actorId: string, raw: unknown): Promise<DeleteLeftoversResult> {
	const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const storeId = input.storeId ?? null;
	if (storeId !== null && typeof storeId !== "string")
		return { ok: false, status: 400, error: "storeId must be a store id" };
	if (storeId !== null && storeId !== DEFAULT_STORE_ID && !(await getStorage(env)).store(storeId)) {
		const tracked = await countTracked(env, storeId);
		if (!tracked) return { ok: false, status: 404, error: "Store not found" };
	}
	const run = await purgeLeftovers(env, { trigger: "manual", storeId, limit: MANUAL_LEFTOVER_LIMIT });
	if (run.skipped === "unsupported")
		return { ok: false, status: 409, error: "Apply the pending database update first", code: "MIGRATION_PENDING" };
	await createAuditLog(env, {
		actorUserId: actorId,
		action: "storage.leftovers_deleted",
		metadata: {
			trigger: "manual",
			storeId,
			deleted: run.deleted,
			cleared: run.cleared,
			kept: run.kept,
			skipped: run.skipped,
		},
	});
	return { ok: true, run };
}

/** The five-minute maintenance's share: a small pass when the automatic cleanup is on; audited when it deleted. */
export async function runAutomaticLeftoverCleanup(env: LeftoverEnv, now = new Date()): Promise<void> {
	const state = await readLeftoverState(env);
	if (!state.available || !state.automatic) return;
	const result = await purgeLeftovers(env, { trigger: "automatic", limit: AUTOMATIC_LEFTOVER_LIMIT, now });
	if (result.deleted)
		await createAuditLog(env, {
			actorUserId: null,
			action: "storage.leftovers_deleted",
			metadata: { trigger: "automatic", deleted: result.deleted, kept: result.kept },
		});
}
