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
