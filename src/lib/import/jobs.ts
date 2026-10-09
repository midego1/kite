import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxes } from "@/db/schema";
import { importJobs } from "@/db/schema/import-jobs";
import { newId } from "@/lib/ids";
import { openSetting, sealSetting } from "@/lib/security/secret-box";
import { getImportMessageUserId, parseImportDestination } from "./destination";
import { openImapSession } from "./imap";
import { chunk, selectRemainingUids } from "./imap-utils";
import { importMessagesToMailbox } from "./service";
import type { ImportMessageInput } from "./types";

export type ImportJobQueueMessage = { kind: "import.imap"; jobId: string };
export type ImportJobRow = typeof importJobs.$inferSelect;

/** Messages fetched per IMAP round trip. */
const FETCH_CHUNK_SIZE = 25;
/**
 * Work per queue invocation. Each message costs a handful of D1/R2 calls, so this
 * keeps one invocation well inside the Workers subrequest and wall-time limits;
 * the job re-enqueues itself to continue.
 */
const MESSAGES_PER_RUN = 200;
const RUN_TIME_BUDGET_MS = 5 * 60_000;
const LEASE_MS = 8 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_STORED_ERRORS = 20;
const ACTIVE_STATUSES = ["pending", "running"] as const;

export function isImportJobQueueMessage(body: unknown): body is ImportJobQueueMessage {
	return (
		typeof body === "object" &&
		body !== null &&
		(body as { kind?: unknown }).kind === "import.imap" &&
		typeof (body as { jobId?: unknown }).jobId === "string"
	);
}

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
	},
): Promise<ImportJobRow> {
	parseImportDestination(input.destination);
	const db = getDb(env);
	const now = new Date();
	const [job] = await db
		.insert(importJobs)
		.values({
			id: newId("ijob"),
			...input,
			password: await sealSetting(env, input.password),
			status: "pending",
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	await enqueueImportJob(env, job.id);
	return job;
}

export async function listImportJobs(env: CloudflareEnv, userId: string, limit = 20): Promise<ImportJobRow[]> {
	return getDb(env)
		.select()
		.from(importJobs)
		.where(eq(importJobs.userId, userId))
		.orderBy(desc(importJobs.createdAt))
		.limit(limit);
}

export async function cancelImportJob(env: CloudflareEnv, userId: string, jobId: string): Promise<boolean> {
	const now = new Date();
	const cancelled = await getDb(env)
		.update(importJobs)
		.set({ status: "cancelled", password: "", leaseUntil: null, updatedAt: now, finishedAt: now })
		.where(
			and(eq(importJobs.id, jobId), eq(importJobs.userId, userId), inArray(importJobs.status, [...ACTIVE_STATUSES])),
		)
		.returning({ id: importJobs.id });
	return cancelled.length > 0;
}

/** Public shape for the API: never includes the source password. */
export function serializeImportJob(job: ImportJobRow) {
	return {
		id: job.id,
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
export async function processImportJob(env: CloudflareEnv, jobId: string): Promise<void> {
	const db = getDb(env);
	const now = new Date();
	const [job] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
	if (!job || !ACTIVE_STATUSES.includes(job.status as (typeof ACTIVE_STATUSES)[number])) return;
	if (job.leaseUntil && job.leaseUntil > now) return;

	const nowSeconds = Math.floor(now.getTime() / 1000);
	const claimed = await db
		.update(importJobs)
		.set({
			status: "running",
			leaseUntil: new Date(now.getTime() + LEASE_MS),
			startedAt: job.startedAt ?? now,
			updatedAt: now,
		})
		.where(
			and(
				eq(importJobs.id, jobId),
				inArray(importJobs.status, [...ACTIVE_STATUSES]),
				or(isNull(importJobs.leaseUntil), lt(importJobs.leaseUntil, now)),
				sql`NOT EXISTS (SELECT 1 FROM import_jobs other WHERE other.id <> ${jobId} AND other.host = ${job.host} AND other.username = ${job.username} AND other.status = 'running' AND other.lease_until > ${nowSeconds})`,
			),
		)
		.returning({ id: importJobs.id });
	if (!claimed.length) {
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

	const destination = parseImportDestination(job.destination);
	const userId = getImportMessageUserId(destination, job.userId, mailbox.userId);
	const startedAt = Date.now();
	let progress = { processed: job.processed, imported: job.imported, skipped: job.skipped, cursorUid: job.cursorUid };
	let errors = parseErrors(job.errors);
	let total = job.total;
	let session: Awaited<ReturnType<typeof openImapSession>> | null = null;

	try {
		session = await openImapSession({ ...job, password: (await openSetting(env, job.password)) ?? "" });
		const allUids = await session.searchUids();
		total = job.maxMessages ? Math.min(job.maxMessages, allUids.length) : allUids.length;
		let remaining = selectRemainingUids(allUids, progress.cursorUid);
		if (job.maxMessages) remaining = remaining.slice(0, Math.max(job.maxMessages - progress.processed, 0));
		const runUids = remaining.slice(0, MESSAGES_PER_RUN);
		const chunks = chunk(runUids, FETCH_CHUNK_SIZE);
		const activeSession = session;
		const fetchChunk = (uids: number[]) => activeSession.fetchMessages(uids.map(String));

		// Fetch the next chunk from IMAP while the current one is written to D1/R2.
		let nextFetch = chunks.length ? fetchChunk(chunks[0]) : null;
		for (let index = 0; index < chunks.length; index += 1) {
			const uids = chunks[index];
			const fetched = await nextFetch!;
			const hasTime = Date.now() - startedAt < RUN_TIME_BUDGET_MS;
			nextFetch = hasTime && index + 1 < chunks.length ? fetchChunk(chunks[index + 1]) : null;
			nextFetch?.catch(() => undefined);

			const batch: ImportMessageInput[] = [];
			for (const uid of uids) {
				const raw = fetched.get(String(uid));
				if (raw) batch.push({ filename: `${job.folder}-${uid}.eml`, raw });
			}
			const result = await importMessagesToMailbox(env, {
				userId,
				mailboxId: mailbox.id,
				destination,
				messages: batch,
			});
			const missing = uids.length - batch.length;
			progress = {
				processed: progress.processed + uids.length,
				imported: progress.imported + result.imported,
				skipped: progress.skipped + result.skipped + missing,
				cursorUid: uids[uids.length - 1],
			};
			errors = [...errors, ...result.errors].slice(-MAX_STORED_ERRORS);

			const stillRunning = await db
				.update(importJobs)
				.set({
					...progress,
					total,
					errors: JSON.stringify(errors),
					leaseUntil: new Date(Date.now() + LEASE_MS),
					updatedAt: new Date(),
				})
				.where(and(eq(importJobs.id, job.id), eq(importJobs.status, "running")))
				.returning({ id: importJobs.id });
			if (!stillRunning.length) {
				// Cancelled from the UI.
				await nextFetch?.catch(() => undefined);
				return;
			}
			if (!nextFetch) break;
		}

		const done = remaining.length <= progress.processed - job.processed;
		if (done) {
			await finishJob(env, { ...job, total }, "completed");
			return;
		}
		await db
			.update(importJobs)
			.set({ leaseUntil: null, attempts: 0, lastError: null, updatedAt: new Date() })
			.where(and(eq(importJobs.id, job.id), eq(importJobs.status, "running")));
		await enqueueImportJob(env, job.id);
	} catch (error) {
		const message = error instanceof Error ? error.message : "IMAP import failed";
		const attempts = job.attempts + 1;
		// Authentication and missing-folder errors will not fix themselves.
		const permanent = /AUTHENTICATIONFAILED|LOGIN|NONEXISTENT|does not exist|not allowed/i.test(message);
		if (permanent || attempts >= MAX_ATTEMPTS) {
			await finishJob(env, { ...job, total }, "failed", message);
			return;
		}
		await db
			.update(importJobs)
			.set({ attempts, lastError: message, leaseUntil: null, total, updatedAt: new Date() })
			.where(and(eq(importJobs.id, job.id), eq(importJobs.status, "running")));
		await enqueueImportJob(env, job.id, 30 * attempts);
	} finally {
		await session?.close().catch(() => undefined);
	}
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

/**
 * Cron safety net: re-enqueues active jobs whose run died without handing off
 * (worker eviction, exhausted queue retries). Without a queue binding it runs
 * one job inline so imports still progress.
 */
export async function resumeStalledImportJobs(env: CloudflareEnv): Promise<void> {
	const db = getDb(env);
	const now = new Date();
	const stale = new Date(now.getTime() - 2 * 60_000);
	const jobs = await db
		.select({ id: importJobs.id })
		.from(importJobs)
		.where(
			and(
				inArray(importJobs.status, [...ACTIVE_STATUSES]),
				or(isNull(importJobs.leaseUntil), lt(importJobs.leaseUntil, now)),
				lt(importJobs.updatedAt, stale),
			),
		)
		.orderBy(importJobs.createdAt)
		.limit(10);
	for (const job of jobs) {
		if (!(await enqueueImportJob(env, job.id))) {
			await processImportJob(env, job.id);
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
