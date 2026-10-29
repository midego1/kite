import { objectClassOf } from "@/lib/storage/object-classes-utils";
import type {
	BackupObjectSource,
	BackupObjectsCursor,
	BackupObjectsManifestPart,
	BackupObjectsMessage,
} from "./objects-types";

const BACKUP_OBJECTS_PREFIX = "backups/objects";
const BACKUP_OBJECT_SOURCES: BackupObjectSource[] = ["messages", "attachments", "bodies"];
/** Objects per queue message; each message also stops early once it has copied this many bytes. */
export const OBJECTS_BATCH_SIZE = 50;
export const OBJECTS_BATCH_BYTES = 256 * 1024 * 1024;
/** Keys R2 deletes in one call. */
export const OBJECTS_DELETE_BATCH = 1000;
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

export function initialBackupObjectsCursor(): BackupObjectsCursor {
	return { source: BACKUP_OBJECT_SOURCES[0]!, after: null, part: 1, count: 0, size: 0, missing: 0 };
}

/**
 * The cursor after a batch: past its last row, on to the next source when this one ran out, or null when every
 * source is done. A batch that copied nothing writes no manifest part, so the part number only moves with one.
 */
export function advanceBackupObjectsCursor(
	cursor: BackupObjectsCursor,
	batch: { lastId: string | null; exhausted: boolean; copied: number; bytes: number; missing: number },
): BackupObjectsCursor | null {
	const wrotePart = batch.copied + batch.missing > 0;
	const totals = {
		part: cursor.part + (wrotePart ? 1 : 0),
		count: cursor.count + batch.copied,
		size: cursor.size + batch.bytes,
		missing: cursor.missing + batch.missing,
	};
	if (!batch.exhausted) return { ...cursor, ...totals, after: batch.lastId ?? cursor.after };
	const next = BACKUP_OBJECT_SOURCES[BACKUP_OBJECT_SOURCES.indexOf(cursor.source) + 1];
	return next ? { ...totals, source: next, after: null } : null;
}

export function estimateBackupObjectBytes(input: {
	messages: number;
	bodyBytes: number;
	attachments: number;
	attachmentBytes: number;
	offloadedBodies: number;
	offloadedBodyBytes: number;
}): { objects: number; bytes: number } {
	const raw = input.messages * HEADER_BYTES + input.bodyBytes + input.attachmentBytes * BASE64_OVERHEAD;
	return {
		objects: input.messages + input.attachments + input.offloadedBodies,
		bytes: Math.round(raw + input.attachmentBytes + input.offloadedBodyBytes),
	};
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
 * A manifest part as read back for a restore. Only keys of mail objects are accepted, so a damaged or edited
 * manifest can never write anywhere else (a backup, a Drive file, branding).
 */
export function parseBackupObjectsManifestPart(value: unknown): BackupObjectsManifestPart {
	const part = value as Partial<BackupObjectsManifestPart> | null;
	if (!part || !Array.isArray(part.objects)) throw new Error("The mail file manifest is damaged");
	const objects = part.objects.filter(
		(item): item is { key: string; size: number } =>
			!!item &&
			typeof item.key === "string" &&
			!item.key.includes("..") &&
			objectClassOf(item.key) === "mail" &&
			typeof item.size === "number",
	);
	if (objects.length !== part.objects.length) throw new Error("The mail file manifest names objects that are not mail");
	const missing = Array.isArray(part.missing) ? part.missing.filter((key) => typeof key === "string") : [];
	return { objects, missing };
}

const KINDS = new Set(["backup.objects.copy", "backup.objects.restore", "backup.objects.delete"]);

export function isBackupObjectsMessage(payload: unknown): payload is BackupObjectsMessage {
	if (typeof payload !== "object" || payload === null) return false;
	const message = payload as { kind?: unknown; backupId?: unknown; prefix?: unknown };
	if (typeof message.kind !== "string" || !KINDS.has(message.kind)) return false;
	if (message.kind === "backup.objects.delete")
		return typeof message.prefix === "string" && message.prefix.startsWith(`${BACKUP_OBJECTS_PREFIX}/`);
	return typeof message.backupId === "string";
}
