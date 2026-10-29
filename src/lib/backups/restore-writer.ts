import { DEFAULT_RESTORE_BATCH_LIMITS, estimateStatementBytes } from "./restore-utils";
import type { RestoreBatchLimits, RestorePosition, RestoreProbe, RestoreStatement } from "./restore-types";

/** Called before each batch is sent, with where the restore will stand once it is committed. */
type BeforeRestoreFlush = (to: RestorePosition | null, probe: RestoreProbe | null) => Promise<void>;

/**
 * Sends restore statements to D1 in batches as they are produced, so a
 * restore never holds more than one batch. Everything that fits in a single
 * batch runs as one transaction; once a batch has been committed the restore
 * is no longer atomic, which `committedBatches` tells the caller.
 */
export class RestoreBatchWriter {
	committedBatches = 0;
	/** Where the restore stands once the last committed batch is in. */
	committed: RestorePosition | null = null;
	private pending: RestoreStatement[] = [];
	private pendingBytes = 0;
	private position: RestorePosition | null = null;
	private probe: RestoreProbe | null = null;

	constructor(
		private readonly db: D1Database,
		private readonly limits: RestoreBatchLimits = DEFAULT_RESTORE_BATCH_LIMITS,
		private readonly beforeFlush?: BeforeRestoreFlush,
	) {}

	/**
	 * Queues a statement. `after` is where the restore stands once it ran; `probe` names a row it inserts, given
	 * for every statement that must not run twice.
	 */
	async add(statement: RestoreStatement, after?: RestorePosition, probe?: RestoreProbe | null): Promise<void> {
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
		const probe = this.probe;
		this.pending = [];
		this.pendingBytes = 0;
		this.probe = null;
		if (this.beforeFlush) await this.beforeFlush(to, probe);
		await this.db.batch(batch.map((statement) => this.db.prepare(statement.sql).bind(...statement.params)));
		this.committedBatches++;
		this.committed = to;
	}
}
