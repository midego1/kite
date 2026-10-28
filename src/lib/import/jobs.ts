import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxes } from "@/db/schema";
import { importJobs } from "@/db/schema/import-jobs";
import { newId } from "@/lib/ids";
import { openSetting, sealSetting } from "@/lib/security/secret-box";
import { getDatabaseSize } from "@/lib/db/size";
import { insertRow, selectRow, selectRows } from "@/lib/db/pending-columns";
import { parseImportDestination } from "./destination";
import { MailServerRefusedError } from "@/lib/net/errors";
import { openImportSession } from "./imap";
import {
	IMPORT_CONFIRMED_NOTE,
	carriedImportNote,
	noteAfterError,
	isDatabaseFull,
	isImportConfirmed,
	needsStartConfirmation,
} from "./size-guard-utils";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import {
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
	LEASE_MS,
	MESSAGES_PER_RUN,
	markPaused,
	pauseIfDatabaseFull,
	runFolderJob,
	type ImportJobRow,
	type ImportRun,
} from "./job-run";

/** @public Named by `env.d.ts` to widen the queue payload; Knip does not scan that file. */
export type ImportJobQueueMessage = { kind: "import.imap"; jobId: string };
export type { ImportJobRow } from "./job-run";

const MAX_ATTEMPTS = 5;
const ACTIVE_STATUSES = ["pending", "running"] as const;
/** A job paused this long is cancelled (its saved source password erased) by the cron safety net. */
const PAUSED_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export async function enqueueImportJob(env: CloudflareEnv, jobId: string, delaySeconds?: number): Promise<boolean> {
	const queue = env.AGENT_QUEUE;
	if (!queue) return false;
	await queue.send({ kind: "import.imap", jobId }, delaySeconds ? { delaySeconds } : undefined);
	return true;
}

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
	const fields = accountJobFields({ gmail, estimateBytes });
	// The folders go in before the first run is queued, so the run never sees a job without them.
	const job = await insertImportJob(env, credentials, fields, { enqueue: false });
	await insertJobFolders(env, job.id, folders);
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

/** Pause from the jobs list: the job keeps its password, cursors and folders and waits for Resume. */
export async function pauseImportJob(env: CloudflareEnv, userId: string, jobId: string): Promise<boolean> {
	return markPaused(
		env,
		and(eq(importJobs.id, jobId), eq(importJobs.userId, userId), inArray(importJobs.status, [...ACTIVE_STATUSES])),
		{ pauseReason: "user" },
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
	if (cancelled.length) await closeOpenFolders(env, jobId);
	return cancelled.length > 0;
}

/**
 * Puts a job paused for the database size back in the queue. Above 90% of the limit it needs `confirmed`, which
 * lets the job go on to 98%; `"needs_confirmation"` asks the caller to ask the user first.
 */
export async function resumeImportJob(
	env: CloudflareEnv,
	userId: string,
	jobId: string,
	options: { confirmed: boolean; sizeOverride?: Parameters<typeof getDatabaseSize>[1] },
): Promise<"resumed" | "not_found" | "needs_confirmation" | "full"> {
	const db = getDb(env);
	const [job] = await db
		.select({ id: importJobs.id, lastError: importJobs.lastError })
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
			leaseUntil: null,
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
	await enqueueImportJob(env, jobId);
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
export async function processImportJob(env: CloudflareEnv, jobId: string, ctx: CapabilityCallContext): Promise<void> {
	const db = getDb(env);
	const now = new Date();
	const job = await selectRow(db, importJobs, eq(importJobs.id, jobId));
	if (!job || !ACTIVE_STATUSES.includes(job.status as (typeof ACTIVE_STATUSES)[number])) return;
	if (job.leaseUntil && job.leaseUntil > now) return;
	if (!(await claimJob(env, job, now))) {
		// Another job for the same account holds the connection; it starts this one when it finishes.
		return;
	}

	const [mailbox] = await db
		.select({ id: mailboxes.id, userId: mailboxes.userId })
		.from(mailboxes)
		.where(eq(mailboxes.id, job.mailboxId))
		.limit(1);
	if (!mailbox) {
		await finishJob(env, job, "failed", "Mailbox no longer exists");
		return;
	}

	if (await pauseIfDatabaseFull(env, job)) return;

	let run: ImportRun | null = null;
	try {
		const session = await openImportSession(env, { ...job, password: (await openSetting(env, job.password)) ?? "" });
		run = {
			env,
			ctx,
			job,
			mailbox,
			session,
			startedAt: Date.now(),
			budget: MESSAGES_PER_RUN,
			progress: { processed: job.processed, imported: job.imported, skipped: job.skipped },
			total: job.total,
			errors: parseErrors(job.errors),
		};
		const outcome = job.scope === "account" ? await runAccountJob(run) : await runFolderJob(run);
		if (outcome === "stopped") return;
		if (outcome === "done") {
			await finishJob(env, { ...job, total: run.total }, "completed");
			return;
		}
		await db
			.update(importJobs)
			.set({ leaseUntil: null, attempts: 0, lastError: carriedImportNote(job.lastError), updatedAt: new Date() })
			.where(and(eq(importJobs.id, job.id), eq(importJobs.status, "running")));
		await enqueueImportJob(env, job.id);
	} catch (error) {
		await recordRunError(env, { ...job, total: run?.total ?? job.total }, error);
	} finally {
		await run?.session.close().catch(() => undefined);
	}
}

/**
 * Takes the job's lease. Jobs that share a source account run one at a time, because providers such as iCloud and
 * Gmail limit concurrent IMAP connections per account.
 */
async function claimJob(env: CloudflareEnv, job: ImportJobRow, now: Date): Promise<boolean> {
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const claimed = await getDb(env)
		.update(importJobs)
		.set({
			status: "running",
			leaseUntil: new Date(now.getTime() + LEASE_MS),
			startedAt: job.startedAt ?? now,
			updatedAt: now,
		})
		.where(
			and(
				eq(importJobs.id, job.id),
				inArray(importJobs.status, [...ACTIVE_STATUSES]),
				or(isNull(importJobs.leaseUntil), lt(importJobs.leaseUntil, now)),
				sql`NOT EXISTS (SELECT 1 FROM import_jobs other WHERE other.id <> ${job.id} AND other.host = ${job.host} AND other.username = ${job.username} AND other.status = 'running' AND other.lease_until > ${nowSeconds})`,
			),
		)
		.returning({ id: importJobs.id });
	return claimed.length > 0;
}

/** A failed run: permanent errors end the job, others are retried with a growing delay. */
async function recordRunError(env: CloudflareEnv, job: ImportJobRow, error: unknown): Promise<void> {
	const message = error instanceof Error ? error.message : "IMAP import failed";
	const attempts = job.attempts + 1;
	if (isPermanentImportError(error, message) || attempts >= MAX_ATTEMPTS) {
		await finishJob(env, job, "failed", message);
		return;
	}
	await getDb(env)
		.update(importJobs)
		.set({
			attempts,
			// A transient error is retried; the confirmation to go on above 90% must survive it.
			lastError: noteAfterError(job.lastError, message),
			leaseUntil: null,
			total: job.total,
			updatedAt: new Date(),
		})
		.where(and(eq(importJobs.id, job.id), eq(importJobs.status, "running")));
	await enqueueImportJob(env, job.id, 30 * attempts);
}

/** Refused connections (no TLS, a private host), authentication and missing-folder errors will not fix themselves. */
function isPermanentImportError(error: unknown, message: string): boolean {
	return (
		error instanceof MailServerRefusedError ||
		/AUTHENTICATIONFAILED|LOGIN|sign-in failed|NONEXISTENT|does not exist|not allowed/i.test(message)
	);
}

async function finishJob(
	env: CloudflareEnv,
	job: ImportJobRow,
	status: "completed" | "failed",
	lastError?: string,
): Promise<void> {
	const db = getDb(env);
	const now = new Date();
	await db
		.update(importJobs)
		.set({
			status,
			password: "",
			leaseUntil: null,
			lastError: lastError ?? null,
			total: job.total,
			updatedAt: now,
			finishedAt: now,
		})
		.where(eq(importJobs.id, job.id));
	if (status === "failed" && job.scope === "account") await closeOpenFolders(env, job.id);
	await startNextJobForAccount(env, job);
}

/** Starts the oldest waiting job that uses the same source account. */
async function startNextJobForAccount(env: CloudflareEnv, job: ImportJobRow): Promise<void> {
	const [next] = await getDb(env)
		.select({ id: importJobs.id })
		.from(importJobs)
		.where(
			and(
				eq(importJobs.host, job.host),
				eq(importJobs.username, job.username),
				ne(importJobs.id, job.id),
				inArray(importJobs.status, [...ACTIVE_STATUSES]),
			),
		)
		.orderBy(importJobs.createdAt)
		.limit(1);
	if (next) await enqueueImportJob(env, next.id);
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
	await db
		.update(importJobs)
		.set({
			status: "cancelled",
			password: "",
			leaseUntil: null,
			lastError: "Cancelled: paused for more than 7 days.",
			updatedAt: now,
			finishedAt: now,
		})
		.where(and(eq(importJobs.status, "paused"), lt(importJobs.updatedAt, new Date(now.getTime() - PAUSED_MAX_AGE_MS))));
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
