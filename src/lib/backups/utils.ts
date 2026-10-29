import type { BackupScheduleType, DatabaseRecord } from "./types";

export const BACKUP_SETTINGS_ID = "default";
export const BACKUP_PREFIX = "backups/database";
/** Uploaded backup files wait here while they are restored, and are deleted afterwards. */
export const BACKUP_UPLOAD_PREFIX = "backups/uploads";

/**
 * How long a backup may stay queued or running before it counts as interrupted.
 * A Worker invocation is killed without running its own error handler when the
 * export outlives the platform limits or a deployment replaces it, which leaves
 * the row unfinished forever. The maintenance cron and the backup list endpoint
 * apply this, so a stuck row heals within five minutes of the threshold. Half an
 * hour is far longer than the export of a large database takes, and well under
 * the daily schedule, so a slow backup is never marked failed while it runs.
 */
export const STALE_BACKUP_AFTER_MS = 30 * 60 * 1000;
export const STALE_BACKUP_ERROR = "Backup was interrupted before it finished";

/**
 * True for a queued or running backup whose own progress is older than the
 * threshold. The start time wins over the creation time, because a queued
 * backup that was picked up is judged by when it started.
 */
export function isStaleBackup(
	backup: { status: string; startedAt: Date | null; createdAt: Date | null },
	now: Date,
): boolean {
	if (backup.status !== "queued" && backup.status !== "running") return false;
	const since = backup.startedAt ?? backup.createdAt;
	if (!since) return false;
	return now.getTime() - since.getTime() > STALE_BACKUP_AFTER_MS;
}

/**
 * Tables that older backups may contain but that no longer exist. They are
 * stripped before validation so those backups stay restorable, and skipped by
 * the coverage check so a database that has not yet applied the migration
 * dropping them can still be backed up.
 */
export const RETIRED_BACKUP_TABLES = ["license_settings"];

export function dropRetiredBackupTables(value: unknown): void {
	if (!value || typeof value !== "object") return;
	const document = value as { tables?: unknown; includedTables?: unknown };
	if (document.tables && typeof document.tables === "object") {
		for (const table of RETIRED_BACKUP_TABLES) delete (document.tables as Record<string, unknown>)[table];
	}
	if (Array.isArray(document.includedTables)) {
		document.includedTables = document.includedTables.filter((table) => !RETIRED_BACKUP_TABLES.includes(table));
	}
}

export function isBackupDue(scheduleType: BackupScheduleType, scheduleValue: number | null, now: Date): boolean {
	if (scheduleType === "daily") return true;
	if (scheduleType === "weekly") return now.getUTCDay() === scheduleValue;
	return now.getUTCDate() === scheduleValue;
}

export function getUtcDayBounds(now: Date): { start: number; end: number } {
	const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return { start, end: start + 86_400_000 };
}

export function createBackupFilename(now: Date): string {
	return `kite-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}

/** Indexes the records of the pre-0019 body table by their message. */
export function indexLegacyMessageBodies(bodyRows: unknown[]): Map<string, DatabaseRecord> {
	const bodiesByMessageId = new Map<string, DatabaseRecord>();
	for (const body of bodyRows) {
		if (!isDatabaseRecord(body) || typeof body.message_id !== "string") {
			throw new Error("Backup contains an invalid message_bodies record");
		}
		bodiesByMessageId.set(body.message_id, body);
	}
	return bodiesByMessageId;
}

/** Moves a pre-0019 body record into its message record, keeping fields the message already has. */
export function mergeLegacyMessageBody(message: DatabaseRecord, bodiesByMessageId: Map<string, DatabaseRecord>): void {
	const body = bodiesByMessageId.get(message.id as string);
	if (!body) return;
	copyMissingBodyField(message, body, "text_body");
	copyMissingBodyField(message, body, "html_body");
	copyMissingBodyField(message, body, "raw_r2_key");
}

/** Booking events from backups written before slugs existed get the hex of their id, which is unique per event. */
export function fillBookingEventSlug(row: DatabaseRecord): void {
	if (row.slug === undefined && typeof row.id === "string")
		row.slug = Array.from(new TextEncoder().encode(row.id))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
}

function copyMissingBodyField(
	message: DatabaseRecord,
	body: DatabaseRecord,
	field: "text_body" | "html_body" | "raw_r2_key",
): void {
	if (!(field in message) && field in body) message[field] = body[field];
}

export function isDatabaseRecord(value: unknown): value is DatabaseRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
