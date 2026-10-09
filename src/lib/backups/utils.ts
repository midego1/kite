import type { BackupScheduleType, DatabaseBackupDocument, DatabaseRecord } from "./types";

export const BACKUP_SETTINGS_ID = "default";
export const BACKUP_PREFIX = "backups/database";

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

/** Moves records from the pre-0019 body table into their message records. */
export function mergeLegacyMessageBodies(document: DatabaseBackupDocument): void {
	const tables = document.tables as Record<string, DatabaseRecord[]>;
	const bodyRows = tables.message_bodies;
	if (!bodyRows) return;

	const bodiesByMessageId = new Map<string, DatabaseRecord>();
	for (const body of bodyRows) {
		if (!isDatabaseRecord(body) || typeof body.message_id !== "string") {
			throw new Error("Backup contains an invalid message_bodies record");
		}
		bodiesByMessageId.set(body.message_id, body);
	}

	for (const message of tables.messages) {
		const body = bodiesByMessageId.get(message.id as string);
		if (!body) continue;
		copyMissingBodyField(message, body, "text_body");
		copyMissingBodyField(message, body, "html_body");
		copyMissingBodyField(message, body, "raw_r2_key");
	}

	delete tables.message_bodies;
}

function copyMissingBodyField(
	message: DatabaseRecord,
	body: DatabaseRecord,
	field: "text_body" | "html_body" | "raw_r2_key",
): void {
	if (!(field in message) && field in body) message[field] = body[field];
}

function isDatabaseRecord(value: unknown): value is DatabaseRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
