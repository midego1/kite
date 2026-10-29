export type SafetyBackupTrigger = "pre-restore" | "pre-migration";

export type SafetyBackup = {
	id: string;
	trigger: SafetyBackupTrigger;
	r2Key: string;
	filename: string;
	size: number;
	createdByUserId: string | null;
	createdAt: number;
	completedAt: number;
};

/** A completed backup's row, in seconds, as a restore writes it back. */
export type KeptBackupRecord = {
	id: string;
	trigger: string;
	r2Key: string;
	filename: string | null;
	size: number | null;
	createdByUserId: string | null;
	createdAt: number;
	startedAt: number | null;
	completedAt: number | null;
	/**
	 * The full-backup columns of migration 0081, carried across the restore so a restored full backup keeps its
	 * mail files (and Restore mail files); absent for a database-only backup and the safety backup.
	 */
	objects?: KeptBackupObjects | null;
};

/** `backups.objects_*` as a restore writes them back; times in seconds. */
export type KeptBackupObjects = {
	status: string;
	prefix: string | null;
	count: number | null;
	size: number | null;
	missing: number | null;
	failed: number | null;
	cursor: string | null;
	restore: string | null;
	updatedAt: number | null;
};
