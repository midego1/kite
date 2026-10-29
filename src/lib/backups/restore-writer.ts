import { DEFAULT_RESTORE_BATCH_LIMITS, estimateStatementBytes, restoreProbe } from "./restore-utils";
import type {
	RestoreBatchLimits,
	RestorePosition,
	RestoreProbe,
	RestoreProbeSource,
	RestoreStatement,
} from "./restore-types";

/** Called before each batch is sent, with where the restore will stand once it is committed. */
type BeforeRestoreFlush = (to: RestorePosition | null, probe: RestoreProbe | null) => Promise<void>;

/**
 * Sends restore statements to D1 in batches as they are produced, so a
 * restore never holds more than one batch. Each batch is one transaction;
 * once one has been committed the database holds part of the restore, which
 * `committedBatches` tells the caller.
 */
export class RestoreBatchWriter {
	committedBatches = 0;
	/** Where the restore stands once the last committed batch is in. */
	committed: RestorePosition | null = null;
	private pending: RestoreStatement[] = [];
	private pendingBytes = 0;
	private position: RestorePosition | null = null;
	private probe: RestoreProbeSource | null = null;

	constructor(
		private readonly db: D1Database,
		private readonly limits: RestoreBatchLimits = DEFAULT_RESTORE_BATCH_LIMITS,
		private readonly beforeFlush?: BeforeRestoreFlush,
	) {}

	/**
	 * Queues a statement. `after` is where the restore stands once it ran; `probe` is the last row it inserts, given
	 * for every statement that must not run twice.
	 */
	async add(statement: RestoreStatement, after?: RestorePosition, probe?: RestoreProbeSource | null): Promise<void> {
		const bytes = estimateStatementBytes(statement);
		if (
			this.pending.length > 0 &&
			(this.pending.length >= this.limits.maxStatements || this.pendingBytes + bytes > this.limits.maxBytes)
		)
			await this.flush();
		this.pending.push(statement);
		this.pendingBytes += bytes;
		if (after) this.position = after;
		if (probe) this.probe = probe;
	}

	async flush(): Promise<void> {
		if (!this.pending.length) return;
		const batch = this.pending;
		const to = this.position;
		const source = this.probe;
		this.pending = [];
		this.pendingBytes = 0;
		this.probe = null;
		if (this.beforeFlush) await this.beforeFlush(to, source ? await restoreProbe(source) : null);
		await this.db.batch(batch.map((statement) => this.db.prepare(statement.sql).bind(...statement.params)));
		this.committedBatches++;
		this.committed = to;
	}
}
