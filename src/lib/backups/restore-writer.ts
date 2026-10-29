import { DEFAULT_RESTORE_BATCH_LIMITS, estimateStatementBytes } from "./restore-utils";
import type { RestoreBatchLimits, RestoreStatement } from "./restore-types";

/**
 * Sends restore statements to D1 in batches as they are produced, so a
 * restore never holds more than one batch. Everything that fits in a single
 * batch runs as one transaction; once a batch has been committed the restore
 * is no longer atomic, which `committedBatches` tells the caller.
 */
export class RestoreBatchWriter {
	committedBatches = 0;
	private pending: RestoreStatement[] = [];
	private pendingBytes = 0;

	constructor(
		private readonly db: D1Database,
		private readonly limits: RestoreBatchLimits = DEFAULT_RESTORE_BATCH_LIMITS,
	) {}

	async add(statement: RestoreStatement): Promise<void> {
		const bytes = estimateStatementBytes(statement);
		if (
			this.pending.length > 0 &&
			(this.pending.length >= this.limits.maxStatements || this.pendingBytes + bytes > this.limits.maxBytes)
		)
			await this.flush();
		this.pending.push(statement);
		this.pendingBytes += bytes;
	}

	async flush(): Promise<void> {
		if (!this.pending.length) return;
		const batch = this.pending;
		this.pending = [];
		this.pendingBytes = 0;
		await this.db.batch(batch.map((statement) => this.db.prepare(statement.sql).bind(...statement.params)));
		this.committedBatches++;
	}
}
