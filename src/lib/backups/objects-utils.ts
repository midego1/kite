import { objectClassOf } from "@/lib/storage/object-classes-utils";
import type {
	BackupObjectsCopyRun,
	BackupObjectSource,
	BackupObjectsManifestPart,
	BackupObjectsMessage,
	BackupObjectsRun,
} from "./objects-types";

const BACKUP_OBJECTS_PREFIX = "backups/objects";
const BACKUP_OBJECT_SOURCES: BackupObjectSource[] = ["messages", "attachments", "bodies"];
/**
 * Objects per queue message, and the bytes after which a message stops early. Each object costs up to about eight
 * subrequests (finding it in up to three stores, checking an earlier copy, reading and writing it), so a message
 * stays near 160 and a consumer batch of five messages well inside the 1,000 a Worker invocation may make.
 */
export const OBJECTS_BATCH_SIZE = 20;
export const OBJECTS_BATCH_BYTES = 128 * 1024 * 1024;
/** Keys R2 deletes in one call. */
export const OBJECTS_DELETE_BATCH = 1000;
/** How long a delivery holds a step; a message that finds the step held is delivered again after it. */
export const OBJECTS_LEASE_MS = 10 * 60 * 1000;
/** Like an export, a copy or restore whose heartbeat is older than this was interrupted. */
const STALE_OBJECTS_AFTER_MS = 30 * 60 * 1000;
export const STALE_OBJECTS_ERROR = "Copying the mail files was interrupted before it finished";

/**
 * The raw MIME holds the attachments again, base64-encoded (4/3 of their size plus line breaks), next to the bodies
 * and roughly 2 KB of headers per message. Raw sizes are not stored, so the estimate builds them from these.
 */
const BASE64_OVERHEAD = 1.37;
const HEADER_BYTES = 2048;

/** `backups/objects/<YYYY-MM-DD>-<backup id>/`, dated by the backup's own start. */
export function backupObjectsPrefix(backupId: string, now: Date): string {
	return `${BACKUP_OBJECTS_PREFIX}/${now.toISOString().slice(0, 10)}-${backupId}/`;
}

/** Only a prefix this module made: never `backups/objects/` itself or anything outside one backup's folder. */
const PREFIX_PATTERN = /^backups\/objects\/\d{4}-\d{2}-\d{2}-bak_[A-Za-z0-9_-]+\/$/;

function isBackupObjectsPrefix(prefix: string): boolean {
	return PREFIX_PATTERN.test(prefix);
}

/** Where the copy of a mail object lives: under the backup's prefix, by its own key. */
export function backupObjectCopyKey(prefix: string, key: string): string {
	return `${prefix}files/${key}`;
}

export function backupObjectsManifestKey(prefix: string): string {
	return `${prefix}manifest.json`;
}

export function backupObjectsManifestPartKey(prefix: string, part: number): string {
	return `${prefix}manifest/${String(part).padStart(6, "0")}.json`;
}

export function initialCopyRun(step: number): BackupObjectsCopyRun {
	return {
		run: "copy",
		step,
		source: BACKUP_OBJECT_SOURCES[0]!,
		after: null,
		part: 1,
		count: 0,
		size: 0,
		missing: 0,
		failed: 0,
	};
}

/**
 * The run after a batch: past its last row, on to the next source when this one ran out, with the totals added and
 * the next step. `done` is set when every source is finished. A batch that handled nothing writes no manifest part,
 * so the part number only moves with one.
 */
export function advanceCopyRun(
	run: BackupObjectsCopyRun,
	batch: { lastId: string | null; exhausted: boolean; copied: number; bytes: number; missing: number; failed: number },
): { next: BackupObjectsCopyRun; done: boolean } {
	const wrotePart = batch.copied + batch.missing + batch.failed > 0;
	const totals: BackupObjectsCopyRun = {
		...run,
		leaseUntil: undefined,
		step: run.step + 1,
		part: run.part + (wrotePart ? 1 : 0),
		count: run.count + batch.copied,
		size: run.size + batch.bytes,
		missing: run.missing + batch.missing,
		failed: run.failed + batch.failed,
	};
	if (!batch.exhausted) return { next: { ...totals, after: batch.lastId ?? run.after }, done: false };
	const source = BACKUP_OBJECT_SOURCES[BACKUP_OBJECT_SOURCES.indexOf(run.source) + 1];
	return source ? { next: { ...totals, source, after: null }, done: false } : { next: totals, done: true };
}

export function parseObjectsRun(value: string | null): BackupObjectsRun | null {
	if (!value) return null;
	try {
		const run = JSON.parse(value) as Partial<BackupObjectsRun>;
		return (run.run === "copy" || run.run === "restore") && typeof run.step === "number"
			? (run as BackupObjectsRun)
			: null;
	} catch {
		return null;
	}
}

/**
 * What a delivery of `step` may do: run it, wait for the delivery holding it, or drop it because the step is done
 * (or the run was replaced by a retry or a restore).
 */
export function objectsStepAction(
	run: BackupObjectsRun | null,
	expected: BackupObjectsRun["run"],
	step: number,
	now: number,
): "run" | "leased" | "done" {
	if (!run || run.run !== expected || run.step !== step) return "done";
	return run.leaseUntil && run.leaseUntil > now ? "leased" : "run";
}

/** Sample-based, so it never reads every message body: the latest messages stand for the rest. */
export function estimateBackupObjectBytes(input: {
	messages: number;
	sample: { size: number; bodyBytes: number; offloaded: number; offloadedBytes: number };
	attachments: number;
	attachmentBytes: number;
}): { objects: number; bytes: number } {
	const { sample } = input;
	const scale = sample.size ? input.messages / sample.size : 0;
	const offloaded = Math.round(sample.offloaded * scale);
	const raw = input.messages * HEADER_BYTES + sample.bodyBytes * scale + input.attachmentBytes * BASE64_OVERHEAD;
	return {
		objects: input.messages + input.attachments + offloaded,
		bytes: Math.round(raw + input.attachmentBytes + sample.offloadedBytes * scale),
	};
}

/**
 * How many full copies of the mail files the schedule keeps at once: every full backup holds its own copy, nothing
 * is shared between backups. Null when backups are kept until deleted, so the space grows with every one.
 */
export function keptFullBackupCopies(settings: {
	enabled: boolean;
	scheduleType: string;
	retentionEnabled: boolean;
	retentionDays: number;
}): number | null {
	if (!settings.retentionEnabled) return null;
	if (!settings.enabled) return 1;
	const interval = settings.scheduleType === "weekly" ? 7 : settings.scheduleType === "monthly" ? 28 : 1;
	return Math.max(1, Math.ceil(settings.retentionDays / interval));
}

/** True when an object copy or restore stopped reporting progress, judged like an interrupted export. */
export function isStaleObjectsRun(
	backup: { objectsStatus: string | null; objectsUpdatedAt: Date | null },
	now: Date,
): boolean {
	if (backup.objectsStatus !== "copying" && backup.objectsStatus !== "restoring") return false;
	if (!backup.objectsUpdatedAt) return true;
	return now.getTime() - backup.objectsUpdatedAt.getTime() > STALE_OBJECTS_AFTER_MS;
}

/**
 * A key a restore may write: a relative path in the Mail class with no empty, `.` or `..` segment, so a damaged or
 * edited manifest can never reach a backup, a Drive file or branding. `report..pdf` is a fine file name.
 */
function isMailObjectKey(key: unknown): key is string {
	if (typeof key !== "string" || !key || key.startsWith("/")) return false;
	if (key.split("/").some((segment) => !segment || segment === "." || segment === "..")) return false;
	return objectClassOf(key) === "mail";
}

/**
 * A manifest part as read back for a restore. Entries that are not a mail object key are skipped and counted rather
 * than failing the part, and a key listed twice is restored once.
 */
export function parseBackupObjectsManifestPart(value: unknown): BackupObjectsManifestPart & { skipped: number } {
	const part = value as { objects?: unknown; missing?: unknown; failed?: unknown } | null;
	if (!part || !Array.isArray(part.objects)) throw new Error("The mail file manifest is damaged");
	const seen = new Set<string>();
	const objects: BackupObjectsManifestPart["objects"] = [];
	let skipped = 0;
	for (const item of part.objects as { key?: unknown; size?: unknown }[]) {
		if (!item || !isMailObjectKey(item.key) || typeof item.size !== "number") skipped++;
		else if (!seen.has(item.key)) {
			seen.add(item.key);
			objects.push({ key: item.key, size: item.size });
		}
	}
	const keys = (list: unknown) =>
		Array.isArray(list) ? list.filter((key): key is string => typeof key === "string") : [];
	return { objects, missing: keys(part.missing), failed: keys(part.failed), skipped };
}

const KINDS = new Set(["backup.objects.copy", "backup.objects.restore", "backup.objects.delete"]);

export function isBackupObjectsMessage(payload: unknown): payload is BackupObjectsMessage {
	if (typeof payload !== "object" || payload === null) return false;
	const message = payload as { kind?: unknown; backupId?: unknown; prefix?: unknown; step?: unknown };
	if (typeof message.kind !== "string" || !KINDS.has(message.kind)) return false;
	if (message.kind === "backup.objects.delete")
		return typeof message.prefix === "string" && isBackupObjectsPrefix(message.prefix);
	return typeof message.backupId === "string" && Number.isInteger(message.step);
}
