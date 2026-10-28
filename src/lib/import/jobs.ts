import { and, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxes } from "@/db/schema";
import { importJobFolders, importJobs } from "@/db/schema/import-jobs";
import { newId } from "@/lib/ids";
import { openSetting, sealSetting } from "@/lib/security/secret-box";
import { getDatabaseSize } from "@/lib/db/size";
import { insertRow, selectRow, selectRows } from "@/lib/db/pending-columns";
import { parseImportDestination } from "./destination";
import { openImportSession } from "./imap";
import {
	IMPORT_CONFIRMED_NOTE,
	carriedImportNote,
	isDatabaseFull,
	isImportConfirmed,
	needsStartConfirmation,
} from "./size-guard-utils";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import {
	ACTIVE_STATUSES,
	claimJob,
	closeFoldersOfEndedJob,
	enqueueImportJob,
	finishJob,
	recordRunError,
	releaseImportLease,
} from "./job-end";
import {
	ImportJobSaveError,
	accountJobFields,
	assertAccountImportsReady,
	closeOpenFolders,
	insertJobFolders,
	listJobFolders,
	runAccountJob,
	serializeJobFolder,
	type ImportJobFolderRow,
} from "./account-jobs";
import type { AccountFolderRequest } from "./folder-mapping-types";
import {
	DEFAULT_IMPORT_TIMING,
	MESSAGES_PER_RUN,
	newLeaseHold,
	underLease,
	markPaused,
	pauseIfDatabaseFull,
	runFolderJob,
	startLeaseHeartbeat,
	type ImportJobRow,
	type ImportTiming,
	type ImportRun,
} from "./job-run";

/** @public Named by `env.d.ts` to widen the queue payload; Knip does not scan that file. */
export type ImportJobQueueMessage = { kind: "import.imap"; jobId: string };
export type { ImportJobRow } from "./job-run";

/** A job paused this long is cancelled (its saved source password erased) by the cron safety net. */
const PAUSED_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export async function createImportJob(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		label: string;
		destination: string;
		host: string;
		port: number;
		secure: boolean;
		username: string;
		password: string;
		folder: string;
		maxMessages: number | null;
		/** "Import anyway" was confirmed while the database is above 90% of its limit. */
		confirmedDatabaseFull?: boolean;
	},
): Promise<ImportJobRow> {
	parseImportDestination(input.destination);
	return insertImportJob(env, input, {});
}

type ImportJobCredentials = {
	userId: string;
	mailboxId: string;
	label: string;
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
	/** "Import anyway" was confirmed while the database is above 90% of its limit. */
	confirmedDatabaseFull?: boolean;
};

/**
 * Saves a job and queues its first run. Rows are written and read column by column (`insertRow`, `selectRow`), so a
 * folder job keeps working before migration 0076 adds the account columns.
 */
async function insertImportJob(
	env: CloudflareEnv,
	input: ImportJobCredentials & { destination?: string; folder?: string; maxMessages?: number | null },
	extra: Partial<typeof importJobs.$inferInsert>,
	options: { enqueue: boolean } = { enqueue: true },
): Promise<ImportJobRow> {
	const { confirmedDatabaseFull, ...fields } = input;
	const db = getDb(env);
	const now = new Date();
	const id = newId("ijob");
	await insertRow(db, importJobs, {
		destination: "",
		folder: "",
		...fields,
		...extra,
		id,
		lastError: confirmedDatabaseFull ? IMPORT_CONFIRMED_NOTE : null,
		password: await sealSetting(env, input.password),
		status: "pending",
		createdAt: now,
		updatedAt: now,
	});
	const job = await selectRow(db, importJobs, eq(importJobs.id, id));
	if (!job) throw new Error("The import could not be saved");
	if (options.enqueue) await enqueueImportJob(env, job.id);
	return job;
}

/**
 * A whole-account job (spec §4.1): the chosen folders, in order, each with its destination already resolved
 * (`folder:<id>`, `system:<status>` or `gmail:labels`). Throws `ImportMigrationPendingError` before migration 0076.
 */
export async function createAccountImportJob(
	env: CloudflareEnv,
	input: ImportJobCredentials & { folders: AccountFolderRequest[]; gmail: boolean },
): Promise<ImportJobRow> {
	await assertAccountImportsReady(env);
	const { folders, gmail, ...credentials } = input;
	const sizes = folders.map((folder) => folder.bytes);
	const estimateBytes = sizes.every((bytes) => bytes !== null) ? sizes.reduce((sum, bytes) => sum + bytes!, 0) : null;
	const counts = folders.map((folder) => folder.messages);
	const total = counts.every((count) => count !== null) ? counts.reduce((sum, count) => sum + count!, 0) : null;
	const fields = accountJobFields({ gmail, estimateBytes, total });
	// The folders go in before the first run is queued, so the run never sees a job without them.
	const job = await insertImportJob(env, credentials, fields, { enqueue: false });
	try {
		await insertJobFolders(env, job.id, folders);
	} catch (error) {
		// No job without its folders: the row goes, and the sealed source password with it.
		console.warn("import.account_job_save_failed", error instanceof Error ? error.name : "unknown");
		const db = getDb(env);
		await db.delete(importJobFolders).where(eq(importJobFolders.jobId, job.id));
		await db.delete(importJobs).where(eq(importJobs.id, job.id));
		throw new ImportJobSaveError();
	}
	await enqueueImportJob(env, job.id);
	return job;
}

export type ListedImportJob = ImportJobRow & { folders: ImportJobFolderRow[] };

/** The user's newest jobs with the folders of their account jobs. */
export async function listImportJobs(env: CloudflareEnv, userId: string, limit = 20): Promise<ListedImportJob[]> {
	const db = getDb(env);
	const newest = await db
		.select({ id: importJobs.id })
		.from(importJobs)
		.where(eq(importJobs.userId, userId))
		.orderBy(desc(importJobs.createdAt))
		.limit(limit);
	if (!newest.length) return [];
	const order = new Map(newest.map((row, index) => [row.id, index]));
	const rows = await selectRows(db, importJobs, inArray(importJobs.id, [...order.keys()]));
	const accountIds = rows.filter((row) => row.scope === "account").map((row) => row.id);
	const folders = await listJobFolders(env, accountIds);
	return rows
		.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
		.map((row) => ({ ...row, folders: folders.get(row.id) ?? [] }));
}

/**
 * Pause from the jobs list: the job keeps its password, cursors and folders and waits for Resume. A running batch
 * keeps its lease until it stops, so Resume right after cannot start a second run beside it.
 */
export async function pauseImportJob(env: CloudflareEnv, userId: string, jobId: string): Promise<boolean> {
	return markPaused(
		env,
		and(eq(importJobs.id, jobId), eq(importJobs.userId, userId), inArray(importJobs.status, [...ACTIVE_STATUSES])),
		{ pauseReason: "user" },
		{ keepLease: true },
	);
}

export async function cancelImportJob(env: CloudflareEnv, userId: string, jobId: string): Promise<boolean> {
	const now = new Date();
	const cancelled = await getDb(env)
		.update(importJobs)
		.set({ status: "cancelled", password: "", leaseUntil: null, updatedAt: now, finishedAt: now })
		.where(
			and(
				eq(importJobs.id, jobId),
				eq(importJobs.userId, userId),
				inArray(importJobs.status, [...ACTIVE_STATUSES, "paused"]),
			),
		)
		.returning({ id: importJobs.id });
	if (cancelled.length) await closeOpenFolders(env, [jobId]);
	return cancelled.length > 0;
}

/**
 * Puts a paused job back in the queue. Above 90% of the limit it needs `confirmed`, which lets the job go on to 98%;
 * `"needs_confirmation"` asks the caller to ask the user first. A lease a running batch still holds is kept: that
 * run takes the job back when it saves its chunk, or hands it on when it stops.
 */
export async function resumeImportJob(
	env: CloudflareEnv,
	userId: string,
	jobId: string,
	options: { confirmed: boolean; sizeOverride?: Parameters<typeof getDatabaseSize>[1] },
): Promise<"resumed" | "not_found" | "needs_confirmation" | "full"> {
	const db = getDb(env);
	const [job] = await db
		.select({ id: importJobs.id, lastError: importJobs.lastError, leaseUntil: importJobs.leaseUntil })
		.from(importJobs)
		.where(and(eq(importJobs.id, jobId), eq(importJobs.userId, userId), eq(importJobs.status, "paused")))
		.limit(1);
	if (!job) return "not_found";
	const size = await getDatabaseSize(env, options.sizeOverride);
	// Past the hard stop it would only run one batch and pause again.
	if (isDatabaseFull(size)) return "full";
	const confirmNeeded = needsStartConfirmation(size);
	if (confirmNeeded && !options.confirmed) return "needs_confirmation";
	const resumed = await db
		.update(importJobs)
		.set({
			status: "pending",
			attempts: 0,
			lastError: confirmNeeded || isImportConfirmed(job.lastError) ? IMPORT_CONFIRMED_NOTE : null,
			updatedAt: new Date(),
		})
		.where(and(eq(importJobs.id, jobId), eq(importJobs.status, "paused")))
		.returning({ id: importJobs.id });
	// Before migration 0076 there is no reason to clear.
	if (resumed.length)
		await db
			.update(importJobs)
			.set({ pauseReason: null, pausedAt: null })
			.where(eq(importJobs.id, jobId))
			.catch(() => undefined);
	if (!resumed.length) return "not_found";
	// A lease still held means a run is finishing its batch, or its worker died. The run queued now would meet the
	// lease and leave, so a second one is queued for when the lease runs out. A live run renews its lease every
	// minute, so that message then finds it held and leaves (the run itself hands the job on); a dead worker's job is
	// claimed by it within one lease (three minutes) instead of waiting for the lease and then the next cron tick.
	await enqueueImportJob(env, jobId);
	const leaseSeconds = job.leaseUntil ? Math.ceil((job.leaseUntil.getTime() - Date.now()) / 1000) : 0;
	if (leaseSeconds > 0) await enqueueImportJob(env, jobId, leaseSeconds + 1);
	return "resumed";
}

/** Public shape for the API: never includes the source password. */
export function serializeImportJob(job: ImportJobRow & { folders?: ImportJobFolderRow[] }) {
	return {
		id: job.id,
		scope: job.scope,
		pauseReason: job.pauseReason,
		pausedAt: job.pausedAt?.toISOString() ?? null,
		estimateBytes: job.estimateBytes,
		folders: (job.folders ?? []).map(serializeJobFolder),
		mailboxId: job.mailboxId,
		label: job.label,
		folder: job.folder,
		host: job.host,
		username: job.username,
		status: job.status,
		total: job.total,
		processed: job.processed,
		imported: job.imported,
		skipped: job.skipped,
		lastError: job.lastError,
		attempts: job.attempts,
		errors: parseErrors(job.errors),
		createdAt: job.createdAt.toISOString(),
		updatedAt: job.updatedAt.toISOString(),
		startedAt: job.startedAt?.toISOString() ?? null,
		finishedAt: job.finishedAt?.toISOString() ?? null,
	};
}

/**
 * Advances one job by up to MESSAGES_PER_RUN messages. Jobs that share a source
 * account run one at a time, because providers such as iCloud and Gmail limit
 * concurrent IMAP connections per account.
 */
export async function processImportJob(
	env: CloudflareEnv,
	jobId: string,
	ctx: CapabilityCallContext,
	timing: ImportTiming = DEFAULT_IMPORT_TIMING,
): Promise<void> {
	const db = getDb(env);
	const now = new Date();
	const job = await selectRow(db, importJobs, eq(importJobs.id, jobId));
	if (!job || !ACTIVE_STATUSES.includes(job.status as (typeof ACTIVE_STATUSES)[number])) return;
	if (job.leaseUntil && job.leaseUntil > now) return;
	const lease = await claimJob(env, job, now, timing.leaseMs);
	if (!lease) {
		// Another job for the same account holds the connection; it starts this one when it finishes.
		return;
	}
	const hold = newLeaseHold(job.id, lease);

	const [mailbox] = await db
		.select({ id: mailboxes.id, userId: mailboxes.userId })
		.from(mailboxes)
		.where(eq(mailboxes.id, job.mailboxId))
		.limit(1);
	if (!mailbox) {
		await finishJob(env, job, hold, "failed", "Mailbox no longer exists");
		return;
	}

	if (await pauseIfDatabaseFull(env, job, { lease })) return;

	let run: ImportRun | null = null;
	const closeSource = () => run?.session.close().catch(() => undefined);
	// From here the lease is renewed for as long as this run lives, however long one IMAP command takes.
	const heartbeat = startLeaseHeartbeat(env, hold, timing);
	try {
		const session = await openImportSession(env, { ...job, password: (await openSetting(env, job.password)) ?? "" });
		run = {
			env,
			ctx,
			job,
			mailbox,
			session,
			hold,
			timing,
			startedAt: Date.now(),
			budget: MESSAGES_PER_RUN,
			progress: { processed: job.processed, imported: job.imported, skipped: job.skipped },
			total: job.total,
			errors: parseErrors(job.errors),
			finishNote: null,
		};
		const outcome = job.scope === "account" ? await runAccountJob(run) : await runFolderJob(run);
		if (outcome === "stopped") return;
		// The source connection is closed before the job is released or finished, so the next run never meets it open.
		await closeSource();
		if (outcome === "done") {
			await finishJob(env, { ...job, total: run.total }, hold, "completed", run.finishNote ?? undefined);
			return;
		}
		const handedOn = await underLease(hold, async (held) => {
			const rows = await db
				.update(importJobs)
				.set({ leaseUntil: null, attempts: 0, lastError: carriedImportNote(job.lastError), updatedAt: new Date() })
				.where(and(eq(importJobs.id, job.id), eq(importJobs.status, "running"), eq(importJobs.leaseUntil, held)))
				.returning({ id: importJobs.id });
			hold.ended = true;
			return rows.length > 0;
		});
		// Paused, resumed or taken over meanwhile: Resume, the release below or the other run queues what is next.
		if (handedOn) await enqueueImportJob(env, job.id);
	} catch (error) {
		await closeSource();
		await recordRunError(env, { ...job, total: run?.total ?? job.total }, hold, error);
	} finally {
		// The heartbeat outlives the source connection, so the lease cannot run out while the socket is still open.
		await closeSource();
		await heartbeat.stop();
		try {
			await releaseImportLease(env, hold);
		} finally {
			// A run in flight when Cancel closed the folders (or that failed) must not leave one open.
			if (job.scope === "account") await closeFoldersOfEndedJob(env, job.id);
		}
	}
}

/** Stalled rows read per page, and the pages one tick may read before it gives up until the next tick. */
const STALLED_PAGE_SIZE = 200;
const STALLED_MAX_PAGES = 10;
const RESUMED_PER_TICK = 10;

/**
 * Cron safety net: re-enqueues active jobs whose run died without handing off
 * (worker eviction, exhausted queue retries). Without a queue binding it runs
 * one job inline so imports still progress. `ownerMayImport` leaves out the jobs of users who
 * are restricted from Import; their rows stay stalled, so candidates are read page by page
 * (keyset on `createdAt`, `id`) until enough allowed jobs are found instead of stopping at the oldest window.
 */
export async function resumeStalledImportJobs(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	ownerMayImport: (userId: string) => Promise<boolean>,
): Promise<void> {
	const db = getDb(env);
	const now = new Date();
	const expired = await db
		.update(importJobs)
		.set({
			status: "cancelled",
			password: "",
			leaseUntil: null,
			lastError: "Cancelled: paused for more than 7 days.",
			updatedAt: now,
			finishedAt: now,
		})
		.where(and(eq(importJobs.status, "paused"), lt(importJobs.updatedAt, new Date(now.getTime() - PAUSED_MAX_AGE_MS))))
		.returning({ id: importJobs.id });
	// As Cancel does: the folders the job never reached are not left waiting.
	await closeOpenFolders(
		env,
		expired.map((job) => job.id),
	);
	const stale = new Date(now.getTime() - 2 * 60_000);
	const stalled = and(
		inArray(importJobs.status, [...ACTIVE_STATUSES]),
		or(isNull(importJobs.leaseUntil), lt(importJobs.leaseUntil, now)),
		lt(importJobs.updatedAt, stale),
	);
	const allowed = new Map<string, boolean>();
	const jobs: string[] = [];
	let after: { createdAt: Date; id: string } | null = null;
	for (let page = 0; page < STALLED_MAX_PAGES && jobs.length < RESUMED_PER_TICK; page += 1) {
		const candidates: { id: string; userId: string; createdAt: Date }[] = await db
			.select({ id: importJobs.id, userId: importJobs.userId, createdAt: importJobs.createdAt })
			.from(importJobs)
			.where(
				after
					? and(
							stalled,
							or(
								gt(importJobs.createdAt, after.createdAt),
								and(eq(importJobs.createdAt, after.createdAt), gt(importJobs.id, after.id)),
							),
						)
					: stalled,
			)
			.orderBy(importJobs.createdAt, importJobs.id)
			.limit(STALLED_PAGE_SIZE);
		for (const job of candidates) {
			if (jobs.length >= RESUMED_PER_TICK) break;
			if (!allowed.has(job.userId)) allowed.set(job.userId, await ownerMayImport(job.userId));
			if (allowed.get(job.userId)) jobs.push(job.id);
		}
		if (candidates.length < STALLED_PAGE_SIZE) break;
		after = candidates[candidates.length - 1];
	}
	for (const id of jobs) {
		if (!(await enqueueImportJob(env, id))) {
			await processImportJob(env, id, ctx);
			return;
		}
	}
}

function parseErrors(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}
