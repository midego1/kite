import type { RestoreSummary } from "./restore-job-types";

export type BackupHealthLevel = "ok" | "failed" | "none";

/** A backup row as the health summary needs it. */
export type BackupHealthRow = {
	id: string;
	status: string;
	trigger: string;
	size: number | null;
	error: string | null;
	createdAt: Date | null;
	startedAt: Date | null;
	completedAt: Date | null;
};

/** What the admin overview shows about backups (`GET /api/backups/health`). */
export type BackupHealth = {
	level: BackupHealthLevel;
	lastSuccess: {
		id: string;
		trigger: string;
		completedAt: string;
		size: number | null;
		/** Null for rows without a start time. */
		durationMs: number | null;
	} | null;
	/** The latest finished run, when it failed. */
	lastFailure: { id: string; trigger: string; failedAt: string; error: string | null } | null;
	inProgress: boolean;
	automatic: { enabled: boolean; scheduleType: string; retentionEnabled: boolean; retentionDays: number } | null;
	/** The latest restore while it runs, for a day after it ended, and until one that needs recovery is resolved. */
	restore: RestoreSummary | null;
};
