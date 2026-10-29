import type { RestoreJob, RestoreJobMessage, RestoreJobStatus, RestoreSummary } from "./restore-job-types";

/** The restore's state object. A `system` key, so it stays on the default store whatever the storage routes say. */
export const RESTORE_JOB_KEY = "system/backup-restore.json";

/** Bumped whenever the job's state or the meaning of its plan and cursor changes. */
export const RESTORE_JOB_VERSION = 1;

const ACTIVE_RESTORE_STATUSES: readonly RestoreJobStatus[] = ["validating", "snapshot", "restoring", "rolling_back"];

/** Wall-clock time one invocation spends writing before it hands over to the next queue message. */
export const RESTORE_CHUNK_MS = 20_000;
/** The lease of a writing step, renewed with every batch. */
const RESTORE_SHORT_LEASE_MS = 2 * 60_000;
/** The lease of a step that reads or writes a whole file without checkpoints, up to a consumer's wall-clock limit. */
const RESTORE_LONG_LEASE_MS = 15 * 60_000;
/** Interrupted invocations a phase may have before the restore rolls back (or, rolling back, gives up). */
const MAX_RESTORE_INTERRUPTIONS = 3;
/** Without a lease or progress for this long, the cron sends the job's message again. */
const RESTORE_STALL_MS = 2 * 60_000;
/** Without progress for this long, the cron gives the job up so the safety backup can be restored. */
const RESTORE_ABANDON_MS = 60 * 60_000;
/** Uploaded files older than this are removed by the cron; a restore reads its upload long before. */
export const RESTORE_UPLOAD_MAX_AGE_MS = 24 * 60 * 60_000;
/** A finished restore stays on the admin overview this long; one that needs recovery until it is resolved. */
const RESTORE_SUMMARY_MS = 24 * 60 * 60_000;

export function restoreJobMessage(restoreId: string, seq: number): RestoreJobMessage {
	return { kind: "backup.restore", restoreId, seq };
}

export function isRestoreJobMessage(payload: unknown): payload is RestoreJobMessage {
	if (typeof payload !== "object" || payload === null) return false;
	const message = payload as Partial<RestoreJobMessage>;
	return message.kind === "backup.restore" && typeof message.restoreId === "string" && typeof message.seq === "number";
}

export function isActiveRestore(job: Pick<RestoreJob, "status">): boolean {
	return ACTIVE_RESTORE_STATUSES.includes(job.status);
}

/** Steps that read a whole file (validation, snapshot, the rollback's validation) hold the long lease. */
export function restoreLeaseMs(job: Pick<RestoreJob, "status" | "rollbackPlan">): number {
	if (job.status === "restoring" || (job.status === "rolling_back" && job.rollbackPlan)) return RESTORE_SHORT_LEASE_MS;
	return RESTORE_LONG_LEASE_MS;
}

/** What the cron does with an active job: nothing, send its message again, or give it up. */
export function restoreMaintenanceAction(
	job: Pick<RestoreJob, "status" | "lease" | "updatedAt">,
	now: number,
): "none" | "resend" | "abandon" {
	if (!isActiveRestore(job)) return "none";
	const idle = now - Date.parse(job.updatedAt);
	if (idle >= RESTORE_ABANDON_MS) return "abandon";
	if (job.lease && job.lease.until > now) return "none";
	return idle >= RESTORE_STALL_MS ? "resend" : "none";
}

/** The state an interrupted phase moves to once it ran out of attempts, or null while it may try again. */
export function interruptedRestorePatch(job: RestoreJob): Partial<RestoreJob> | null {
	if (job.interruptions <= MAX_RESTORE_INTERRUPTIONS) return null;
	// A recovery has nothing to roll back to but the backup it restores: it stays to be recovered.
	if (job.recoveryOf)
		return { status: "failed", error: "Restoring the previous data was interrupted repeatedly", needsRecovery: true };
	if (job.status === "restoring")
		return {
			status: "rolling_back",
			error: "The restore was interrupted repeatedly before it finished",
			cursor: null,
			interruptions: 0,
		};
	if (job.status === "rolling_back")
		return {
			status: "failed",
			error: `${job.error ?? "The restore failed"}, and the automatic rollback was interrupted repeatedly`,
			needsRecovery: true,
		};
	return {
		status: "failed",
		error: "The restore was interrupted repeatedly before it changed anything; the backup may be too large to check",
	};
}

/**
 * How a job written by another version of Kite goes on, or null for a job of this version: its plan and cursor
 * may mean something else now, so it starts over from validation, or rolls back with a plan made afresh once it
 * may have written something (a recovery simply starts over).
 */
export function versionedRestorePatch(job: RestoreJob): Partial<RestoreJob> | null {
	if (job.version === RESTORE_JOB_VERSION) return null;
	const reset = { version: RESTORE_JOB_VERSION, cursor: null, rollbackPlan: null, interruptions: 0, schema: null };
	if (job.changed && !job.recoveryOf)
		return {
			...reset,
			status: "rolling_back",
			error: job.error ?? "Kite was updated while the restore ran, so it was rolled back",
		};
	return { ...reset, status: "validating", plan: null, safety: job.recoveryOf ? job.safety : null };
}

export function summarizeRestoreJob(job: RestoreJob | null, now: number): RestoreSummary | null {
	if (!job) return null;
	const active = isActiveRestore(job);
	const recent = job.finishedAt !== null && now - Date.parse(job.finishedAt) < RESTORE_SUMMARY_MS;
	if (!active && !job.needsRecovery && !recent) return null;
	return {
		id: job.id,
		status: job.status,
		active,
		createdAt: job.createdAt,
		finishedAt: job.finishedAt,
		error: job.error,
		needsRecovery: job.needsRecovery,
		recovery: !!job.recoveryOf,
		safetyBackup: job.safety ? { id: job.safety.id, filename: job.safety.filename } : null,
	};
}

/** The outcome of a finished restore in words, or null while it runs or when it succeeded. */
export function restoreOutcomeText(
	restore: Pick<RestoreSummary, "status" | "error" | "needsRecovery"> & { recovery?: boolean },
): string | null {
	const reason = restore.error ? `: ${restore.error}` : ".";
	if (restore.recovery && restore.status === "failed") return `Restoring the previous data failed${reason}`;
	if (restore.status === "rolled_back") return `The restore failed and the previous data was put back${reason}`;
	if (restore.status !== "failed") return null;
	return restore.needsRecovery
		? `The restore failed and could not be rolled back${reason}`
		: `The restore failed and nothing was changed${reason}`;
}
