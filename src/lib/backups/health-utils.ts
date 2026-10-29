import type { BackupHealth, BackupHealthRow } from "./health-types";

function iso(date: Date | null): string | null {
	return date ? date.toISOString() : null;
}

/**
 * Summarises backups for the admin overview: the latest successful one with
 * its size and duration, and a failure when the latest finished run failed
 * (a later success clears it).
 */
export function summarizeBackupHealth(input: {
	lastCompleted: BackupHealthRow | null;
	lastFinished: BackupHealthRow | null;
	inProgress: boolean;
	automatic: BackupHealth["automatic"];
	restore?: BackupHealth["restore"];
}): BackupHealth {
	const { lastCompleted, lastFinished } = input;
	const lastSuccess =
		lastCompleted && lastCompleted.completedAt
			? {
					id: lastCompleted.id,
					trigger: lastCompleted.trigger,
					completedAt: lastCompleted.completedAt.toISOString(),
					size: lastCompleted.size,
					durationMs: lastCompleted.startedAt
						? Math.max(0, lastCompleted.completedAt.getTime() - lastCompleted.startedAt.getTime())
						: null,
				}
			: null;
	const lastFailure =
		lastFinished?.status === "failed"
			? {
					id: lastFinished.id,
					trigger: lastFinished.trigger,
					failedAt: iso(lastFinished.completedAt ?? lastFinished.createdAt) ?? "",
					error: lastFinished.error,
				}
			: null;
	return {
		level: lastFailure ? "failed" : lastSuccess ? "ok" : "none",
		lastSuccess,
		lastFailure,
		inProgress: input.inProgress,
		automatic: input.automatic,
		restore: input.restore ?? null,
	};
}

/** "850 ms", "12 s", "3 min 5 s", "1 h 2 min". */
export function formatBackupDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
