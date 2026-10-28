import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { folders as kiteFolders } from "@/db/schema";
import { importJobFolders } from "@/db/schema/import-jobs";
import { newId } from "@/lib/ids";
import { encodeRawMime } from "@/lib/email/module-import-utils";
import type { HostImportMessage, HostImportResult } from "@/lib/modules/host-types";
import { ensureImportFolder } from "./folders";
import { GMAIL_LABELS_DESTINATION, gmailLabelDestination } from "./folder-mapping-utils";
import type { ImportFolderRole } from "./folder-mapping-types";
import { hostImportMessageFromImap, selectRemainingUids } from "./imap-utils";
import {
	addChunkResult,
	fetchInChunks,
	hasRunTime,
	importBatch,
	recordChunk,
	type ImportRun,
	type ImportRunOutcome,
} from "./job-run";

export type ImportJobFolderRow = typeof importJobFolders.$inferSelect & {
	/** The Kite folder a `folder:<id>` destination names, for the jobs list. */
	destinationName?: string | null;
};

/** Before migration 0075 there is no `import_job_folders`; account imports wait for it. */
export class ImportMigrationPendingError extends Error {
	constructor() {
		super("Apply the database update to import a whole account");
	}
}

/** Throws `ImportMigrationPendingError` while the folder table is missing. */
export async function assertAccountImportsReady(env: CloudflareEnv): Promise<void> {
	try {
		await getDb(env).select({ id: importJobFolders.id }).from(importJobFolders).limit(1);
	} catch {
		throw new ImportMigrationPendingError();
	}
}

/** Saves the folders of a new account job in order; D1 binds at most 100 parameters per statement. */
export async function insertJobFolders(
	env: CloudflareEnv,
	jobId: string,
	folders: { sourceName: string; role: ImportFolderRole; destination: string; bytes: number | null }[],
): Promise<void> {
	const now = new Date();
	const rows = folders.map((folder, position) => ({
		id: newId("ijf"),
		jobId,
		position,
		sourceName: folder.sourceName,
		role: folder.role,
		destination: folder.destination,
		totalBytes: folder.bytes,
		updatedAt: now,
	}));
	for (let index = 0; index < rows.length; index += 10)
		await getDb(env)
			.insert(importJobFolders)
			.values(rows.slice(index, index + 10));
}

/** The folders of these jobs by job id, in order; empty before migration 0075. */
export async function listJobFolders(env: CloudflareEnv, jobIds: string[]): Promise<Map<string, ImportJobFolderRow[]>> {
	const byJob = new Map<string, ImportJobFolderRow[]>();
	if (!jobIds.length) return byJob;
	const rows = await getDb(env)
		.select()
		.from(importJobFolders)
		.where(inArray(importJobFolders.jobId, jobIds))
		.orderBy(asc(importJobFolders.jobId), asc(importJobFolders.position))
		.catch(() => [] as ImportJobFolderRow[]);
	const folderIds = [
		...new Set(rows.filter((row) => row.destination.startsWith("folder:")).map((row) => row.destination.slice(7))),
	];
	const names = new Map<string, string>();
	for (let index = 0; index < folderIds.length; index += 90) {
		const found = await getDb(env)
			.select({ id: kiteFolders.id, name: kiteFolders.name })
			.from(kiteFolders)
			.where(inArray(kiteFolders.id, folderIds.slice(index, index + 90)));
		for (const folder of found) names.set(folder.id, folder.name);
	}
	for (const row of rows) {
		const destinationName = row.destination.startsWith("folder:")
			? (names.get(row.destination.slice(7)) ?? null)
			: null;
		byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), { ...row, destinationName }]);
	}
	return byJob;
}

/** Public shape of one folder of an account job. */
export function serializeJobFolder(folder: ImportJobFolderRow) {
	return {
		sourceName: folder.sourceName,
		role: folder.role,
		destination: folder.destination,
		destinationName: folder.destinationName ?? null,
		status: folder.status,
		total: folder.total,
		totalBytes: folder.totalBytes,
		processed: folder.processed,
		imported: folder.imported,
		skipped: folder.skipped,
		multiLabel: folder.multiLabel,
		lastError: folder.lastError,
	};
}

/** The job's own progress is the sum of its folders'; its total is known once every folder has been examined. */
function jobTotal(folders: ImportJobFolderRow[]): number | null {
	let total = 0;
	for (const folder of folders) {
		if (folder.status === "skipped" || folder.status === "failed") total += folder.processed;
		else if (folder.total === null) return null;
		else total += folder.total;
	}
	return total;
}

async function updateFolder(env: CloudflareEnv, folder: ImportJobFolderRow, fields: Partial<ImportJobFolderRow>) {
	Object.assign(folder, fields);
	await getDb(env)
		.update(importJobFolders)
		.set({ ...fields, updatedAt: new Date() })
		.where(eq(importJobFolders.id, folder.id));
}

/** A NO or BAD to EXAMINE (the folder is gone or not selectable) fails that folder, not the whole job. */
const isFolderRefusal = (error: unknown) =>
	error instanceof Error && /^IMAP command failed: (NO|BAD)\b/.test(error.message);

/**
 * One invocation of a whole-account job (spec §4.1): its folders one after another on the job's lease, each from
 * its own cursor, until the run's budget or time is spent.
 */
export async function runAccountJob(run: ImportRun): Promise<ImportRunOutcome> {
	const folders = (await listJobFolders(run.env, [run.job.id])).get(run.job.id) ?? [];
	const labelDestinations = new Map<string, string>();
	for (const folder of folders) {
		if (folder.status !== "pending" && folder.status !== "running") continue;
		if (run.budget <= 0 || !hasRunTime(run)) return "more";
		const outcome = await runAccountFolder(run, folders, folder, labelDestinations);
		if (outcome !== "next") return outcome;
	}
	run.total = jobTotal(folders);
	return "done";
}

async function runAccountFolder(
	run: ImportRun,
	folders: ImportJobFolderRow[],
	folder: ImportJobFolderRow,
	labelDestinations: Map<string, string>,
): Promise<ImportRunOutcome | "next"> {
	let uidValidity: number | null;
	try {
		({ uidValidity } = await run.session.examine(folder.sourceName));
	} catch (error) {
		if (!isFolderRefusal(error)) throw error;
		await updateFolder(run.env, folder, { status: "failed", lastError: (error as Error).message });
		return "next";
	}
	// A new UIDVALIDITY means the old UIDs mean nothing: start the folder over; dedupe skips what is in Kite.
	const restart = folder.uidvalidity !== null && uidValidity !== null && uidValidity !== folder.uidvalidity;
	const uids = await run.session.searchUids();
	const remaining = selectRemainingUids(uids, restart ? null : folder.cursorUid);
	await updateFolder(run.env, folder, {
		status: "running",
		uidvalidity: uidValidity,
		total: restart ? folder.processed + remaining.length : Math.max(uids.length, folder.processed),
		cursorUid: restart ? null : folder.cursorUid,
	});
	run.total = jobTotal(folders);
	const gmail = folder.destination === GMAIL_LABELS_DESTINATION;
	const handled = await fetchInChunks(
		run,
		remaining.slice(0, run.budget),
		{ gmailLabels: gmail },
		async (part, fetched) => {
			const groups = new Map<string, HostImportMessage[]>();
			let missing = 0;
			let drafts = 0;
			let multiLabel = 0;
			for (const uid of part) {
				const message = fetched.get(String(uid));
				if (!message) {
					missing += 1;
					continue;
				}
				let destination = folder.destination;
				if (gmail) {
					const target = gmailLabelDestination(message.labels ?? []);
					if (target.userLabels > 1) multiLabel += 1;
					if (!target.destination) {
						drafts += 1;
						continue;
					}
					destination = await labelDestination(run, labelDestinations, target.destination);
				}
				const filename = `${folder.sourceName}-${uid}.eml`;
				groups.set(destination, [
					...(groups.get(destination) ?? []),
					hostImportMessageFromImap(filename, message, encodeRawMime),
				]);
			}
			const result: HostImportResult = { imported: 0, skipped: 0, failed: 0, errors: [] };
			for (const [destination, messages] of groups) {
				const batch = await importBatch(run, destination, messages);
				result.imported += batch.imported;
				result.skipped += batch.skipped;
				result.failed += batch.failed;
				result.errors.push(...batch.errors);
			}
			const skipped = result.skipped + result.failed + missing + drafts;
			await updateFolder(run.env, folder, {
				processed: folder.processed + part.length,
				imported: folder.imported + result.imported,
				skipped: folder.skipped + skipped,
				multiLabel: folder.multiLabel + multiLabel,
				cursorUid: part[part.length - 1],
			});
			addChunkResult(run, part.length, { ...result, missing: missing + drafts });
			return recordChunk(run.env, run.job, { ...run.progress, cursorUid: null, total: run.total, errors: run.errors });
		},
	);
	if (handled === null) return "stopped";
	if (handled < remaining.length) return "more";
	await updateFolder(run.env, folder, { status: "completed", lastError: null });
	return "next";
}

/** A Gmail label's Kite folder, created the first time this run meets it. */
async function labelDestination(run: ImportRun, cache: Map<string, string>, destination: string): Promise<string> {
	if (!destination.startsWith("new:")) return destination;
	const cached = cache.get(destination);
	if (cached) return cached;
	const resolved = `folder:${await ensureImportFolder(run.env, run.mailbox, destination.slice(4))}`;
	cache.set(destination, resolved);
	return resolved;
}

/** The job row's own fields of a new account job, before its folders are inserted. */
export function accountJobFields(options: { gmail: boolean; estimateBytes: number | null }) {
	return {
		scope: "account" as const,
		folder: "",
		destination: "account",
		options: JSON.stringify({ gmail: options.gmail }),
		estimateBytes: options.estimateBytes,
	};
}

/** Marks every unfinished folder of a job as skipped, when the job ends without them. */
export async function closeOpenFolders(env: CloudflareEnv, jobId: string): Promise<void> {
	await getDb(env)
		.update(importJobFolders)
		.set({ status: "skipped", updatedAt: new Date() })
		.where(and(eq(importJobFolders.jobId, jobId), inArray(importJobFolders.status, ["pending", "running"])))
		.catch(() => undefined);
}
