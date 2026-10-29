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
};
