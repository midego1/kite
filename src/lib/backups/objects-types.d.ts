/** Where the mail objects of the database come from, copied in this order. */
export type BackupObjectSource = "messages" | "attachments" | "bodies";

/**
 * The state of a copy or restore, stored in `backups.objects_cursor`. `step` counts batches: a queue message names
 * the step it is for, so a duplicate or late message for a step already done is ignored, and `leaseUntil` keeps
 * two deliveries of the same step from running at once.
 */
type RunBase = { step: number; leaseUntil?: number };

export type BackupObjectsCopyRun = RunBase & {
	run: "copy";
	source: BackupObjectSource;
	/** The last row id handled from `source`, null at its start. */
	after: string | null;
	/** The number of the next manifest part. */
	part: number;
	count: number;
	size: number;
	missing: number;
	failed: number;
};

export type BackupObjectsRestoreRun = RunBase & {
	run: "restore";
	/** The manifest part to restore next. */
	part: number;
	restored: number;
	present: number;
	failed: number;
};

export type BackupObjectsRun = BackupObjectsCopyRun | BackupObjectsRestoreRun;

/** `backups.objects_restore`: what the last restore of the mail files did. */
export type BackupObjectsRestoreResult = {
	restored: number;
	present: number;
	failed: number;
	finishedAt: string;
	/** True when the restore stopped reporting progress and was ended by the stale check. */
	interrupted?: boolean;
};

export type BackupObjectsCopyMessage = { kind: "backup.objects.copy"; backupId: string; step: number };
export type BackupObjectsRestoreMessage = { kind: "backup.objects.restore"; backupId: string; step: number };
export type BackupObjectsDeleteMessage = { kind: "backup.objects.delete"; prefix: string };
export type BackupObjectsMessage = BackupObjectsCopyMessage | BackupObjectsRestoreMessage | BackupObjectsDeleteMessage;

/** One manifest part: the objects of one batch, by their own key. */
export type BackupObjectsManifestPart = {
	objects: { key: string; size: number }[];
	/** Keys the database names that no store held when the batch ran. */
	missing: string[];
	/** Keys whose copy failed (a read or write error). */
	failed: string[];
};

/** `manifest.json` at the root of a full backup's object prefix, written when the copy finished. */
export type BackupObjectsManifest = {
	format: "kite-backup-objects";
	version: 1;
	backupId: string;
	/** The database backup the objects belong to. */
	database: string | null;
	completedAt: string;
	parts: number;
	objects: number;
	bytes: number;
	missing: number;
	failed: number;
};

/** A rough size of the objects a full backup would copy, from the database alone. */
export type BackupObjectsEstimate = { objects: number; bytes: number };
