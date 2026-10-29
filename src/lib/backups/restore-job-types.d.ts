import type { RestoreCursor, RestorePlan } from "./restore-types";
import type { KeptBackupRecord } from "./safety-types";

/**
 * validating → snapshot → restoring → completed, or → rolling_back → rolled_back when the restore fails after
 * writing. `failed` means nothing was changed, unless `needsRecovery` says the rollback could not finish either.
 */
export type RestoreJobStatus =
	"validating" | "snapshot" | "restoring" | "rolling_back" | "completed" | "rolled_back" | "failed";

/** Asks the consumer to continue restore `restoreId` at step `seq`; a message for any other step is stale. */
export type RestoreJobMessage = { kind: "backup.restore"; restoreId: string; seq: number };

/**
 * A restore's durable state, kept in a `system` object rather than a table the restore replaces, so it survives
 * the restore itself, an interrupted invocation and a restart.
 */
export type RestoreJob = {
	id: string;
	status: RestoreJobStatus;
	seq: number;
	/** Held by the invocation working on the job; one left behind means that invocation died. */
	lease: { id: string; until: number } | null;
	userId: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	/** The file being restored; an upload is removed when the job ends. */
	source: { key: string; upload: boolean; filename: string | null };
	/** Completed backups whose rows the restore writes back (the backup being restored). */
	kept: KeptBackupRecord[];
	plan: RestorePlan | null;
	/** The snapshot taken before anything was written, which the rollback restores. */
	safety: KeptBackupRecord | null;
	rollbackPlan: RestorePlan | null;
	cursor: RestoreCursor | null;
	/** Invocations of the current phase that died without finishing. */
	interruptions: number;
	rowCount: number;
	error: string | null;
	/** True once a batch may have been committed: from then on a failure needs the rollback. */
	changed: boolean;
	/** The rollback did not finish either; restoring `safety` puts the previous data back. */
	needsRecovery: boolean;
};

/** What the admin overview and the Backups page show about the latest restore. */
export type RestoreSummary = {
	id: string;
	status: RestoreJobStatus;
	active: boolean;
	createdAt: string;
	finishedAt: string | null;
	error: string | null;
	needsRecovery: boolean;
	safetyBackup: { id: string; filename: string | null } | null;
};
