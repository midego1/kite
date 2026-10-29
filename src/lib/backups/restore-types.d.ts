export type RestoreStatement = { sql: string; params: (string | number | null)[] };

export type RestoreBatchLimits = { maxStatements: number; maxBytes: number };

export type RestoreOutcome = {
	atomic: boolean;
	safetyBackupId: string | null;
	rowCount: number;
};

/** A backup file read by byte range: an object in storage, or bytes already in memory. */
export type BackupSource = {
	size: number;
	read(offset: number, length: number): Promise<Uint8Array>;
	/** Bytes per read; BACKUP_PAGE_SIZE when unset. */
	pageSize?: number;
};

/** "document" scans a whole backup file; "rows" scans one table's array, read back by its range. */
export type BackupScanMode = "document" | "rows";

export type BackupScanEvent =
	| { type: "member"; key: string; raw: Uint8Array }
	| { type: "tableValue"; name: string; raw: Uint8Array }
	| { type: "tablesStart" }
	| { type: "tableStart"; name: string; start: number }
	| { type: "row"; name: string; raw: Uint8Array; start: number; end: number }
	| { type: "tableEnd"; name: string; end: number };

/** Where one table's rows sit in the file: `start` is its `[`, `end` the byte after its `]`. */
export type BackupTableRange = { start: number; end: number; rows: number };

export type PreparedRestoreTable = {
	name: string;
	/** Null when the backup has no rows for the table; it is still emptied. */
	range: BackupTableRange | null;
	columns: string[];
	/** The primary key columns, used to tell whether a batch was committed when a restore resumes. */
	primaryKey: string[];
};

/**
 * A validated backup, ready to be written table by table from its source. Plain JSON, so a restore job can keep
 * it with its state and continue in a later invocation without validating the file again.
 */
export type RestorePlan = {
	tables: PreparedRestoreTable[];
	/** The pre-0019 `message_bodies` table, merged into messages once they are restored. */
	legacyBodies: BackupTableRange | null;
	rowCount: number;
	/** The tables this restore leaves untouched (PRESERVED_ON_RESTORE), decided before anything was written. */
	preserved: string[];
};

export type PreparedRestore = RestorePlan & { source: BackupSource };

/** One step of a restore, in order: empty the tables, then each table's rows, the legacy bodies and the kept rows. */
export type RestoreSegment =
	| { kind: "deletes" }
	| { kind: "rows"; table: PreparedRestoreTable }
	| { kind: "bodies"; range: BackupTableRange; columns: string[] }
	| { kind: "kept" };

/**
 * Where a restore stands: in `segment`, after the row ending at byte `offset` (null at the segment's start), with
 * `rows` of the segment's rows written.
 */
export type RestorePosition = { segment: number; offset: number | null; rows: number };

/** A row of a batch, by its primary key (or every column), whose presence proves that the batch was committed. */
export type RestoreProbe = { table: string; values: Record<string, string | number | boolean | null> };

/**
 * A restore's checkpoint. `pending` is the batch being committed when it was written: if its probe row exists,
 * the batch was committed and the restore continues from `to`, otherwise (or when it had nothing to probe, only
 * statements that may run twice) from `at`.
 */
export type RestoreCursor = {
	at: RestorePosition;
	pending: { to: RestorePosition; probe: RestoreProbe | null } | null;
};

export type RestoreRunOptions = {
	writer?: import("./restore-writer").RestoreBatchWriter;
	/** Upserts of backup rows that must stay listed, run right after the `backups` table is restored. */
	keep?: RestoreStatement[];
	from?: RestorePosition;
	/** Epoch ms: stop at the first batch boundary after it and return where to continue. */
	deadline?: number;
};
