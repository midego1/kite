/** Which way the admin attachment storage job converts (`docs/specs/attachments-once.md` §5.5). */
export type AttachmentStorageDirection = "reclaim" | "materialize";

/**
 * What a batch walks: `reclaim` the messages with unchecked 'object' rows, `materialize` the 'raw' rows, then
 * `unshare` the 'object' rows that name an object an older row also names.
 */
export type AttachmentStoragePhase = "reclaim" | "materialize" | "unshare";

export type AttachmentStorageJobStatus = "running" | "completed" | "failed" | "cancelled";

/** Why a running job stopped by itself. */
export type AttachmentStorageStopReason = "raw_index_off";

/**
 * Counters a batch adds to its job when it finishes. A batch killed part way records nothing, and the rows it changed
 * are not selected again, so after such a kill the counters can be lower than what changed; the rows stay the truth.
 */
export interface AttachmentStorageCounters {
	/** Rows looked at. */
	done: number;
	/** Rows whose layout changed: to 'raw' on reclaim, to 'object' on materialize. */
	converted: number;
	/** Rows given an object of their own because an older row named the same one. */
	unshared: number;
	/** Rows left as they were because their bytes could not be verified in the raw message. */
	unmatched: number;
	/** Rows that could not be processed (their raw message or object is gone). */
	failed: number;
}

/** The job, stored as JSON in `app_settings.attachment_storage_job` (migration 0090). */
export interface AttachmentStorageJob extends AttachmentStorageCounters {
	id: string;
	direction: AttachmentStorageDirection;
	status: AttachmentStorageJobStatus;
	phase: AttachmentStoragePhase;
	/** The last id the phase finished (a message id on reclaim, an attachment id otherwise); null at its start. */
	cursor: string | null;
	/** The batch the next queue message must carry; a message for any other batch is stale and dropped. */
	batch: number;
	/** Epoch ms until which a delivery holds the job for its batch. */
	leaseUntil?: number;
	startedAt: number;
	/** Epoch ms of the last claim or finished batch. */
	heartbeatAt: number;
	finishedAt?: number;
	startedBy: string | null;
	/** Rows to look at, counted when the job (and, for materialize, the unshare phase) started. */
	total: number;
	/** Consecutive batches that failed as a whole; the job fails at `MAX_BATCH_FAILURES`. */
	failures: number;
	lastError: string | null;
	stopReason?: AttachmentStorageStopReason;
	/** Development and e2e only (`ATTACHMENT_STORAGE_TEST_HOOKS`): the next batch dies after this many items. */
	testCrashAfter?: number;
}

/** The queue message that runs one batch, on `OUTBOUND_QUEUE`. */
export interface AttachmentStorageJobMessage {
	kind: "attachments.storage";
	jobId: string;
	batch: number;
}

/** What one batch did and where the phase continues. */
export interface AttachmentStorageBatchResult extends AttachmentStorageCounters {
	cursor: string | null;
	/** The phase has nothing after `cursor`. */
	exhausted: boolean;
	lastError: string | null;
}

/** What a batch may still spend: items, bytes read and storage plus database operations. */
export interface AttachmentStorageBudget {
	items: number;
	bytes: number;
	operations: number;
}

/** The job as the admin API shows it. */
export interface AttachmentStorageJobView extends AttachmentStorageCounters {
	id: string;
	direction: AttachmentStorageDirection;
	/** `interrupted` is a running job whose batches stopped arriving; starting it again resumes it. */
	status: AttachmentStorageJobStatus | "interrupted";
	phase: AttachmentStoragePhase;
	total: number;
	startedAt: string;
	finishedAt: string | null;
	lastError: string | null;
	stopReason: AttachmentStorageStopReason | null;
}
