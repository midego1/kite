/** Where the mail objects of the database come from, copied in this order. */
export type BackupObjectSource = "messages" | "attachments" | "bodies";

/** How far a copy has got; carried by each queue message, so a retried message repeats exactly its own batch. */
export type BackupObjectsCursor = {
	source: BackupObjectSource;
	/** The last row id copied from `source`, null at its start. */
	after: string | null;
	/** The number of the next manifest part. */
	part: number;
	count: number;
	size: number;
	missing: number;
};

export type BackupObjectsCopyMessage = { kind: "backup.objects.copy"; backupId: string; cursor: BackupObjectsCursor };
export type BackupObjectsRestoreMessage = {
	kind: "backup.objects.restore";
	backupId: string;
	part: number;
	restored: number;
	present: number;
	failed: number;
};
export type BackupObjectsDeleteMessage = { kind: "backup.objects.delete"; prefix: string };
export type BackupObjectsMessage = BackupObjectsCopyMessage | BackupObjectsRestoreMessage | BackupObjectsDeleteMessage;

/** One manifest part: the objects of one batch, by their own key. */
export type BackupObjectsManifestPart = {
	objects: { key: string; size: number }[];
	/** Keys the database names that no store held when the batch ran. */
	missing: string[];
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
};

/** A rough size of the objects a full backup would copy, from the database alone. */
export type BackupObjectsEstimate = { objects: number; bytes: number };
