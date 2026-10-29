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
	| { type: "tableStart"; name: string; start: number }
	| { type: "row"; name: string; raw: Uint8Array; start: number; end: number }
	| { type: "tableEnd"; name: string; end: number };

/** Where one table's rows sit in the file: `start` is its `[`, `end` the byte after its `]`. */
export type BackupTableRange = { start: number; end: number; rows: number };

export type PreparedRestoreTable = {
	name: string;
	/** Null when the backup has no rows for the table; it is still emptied. */
	range: BackupTableRange | null;
	columns: Set<string>;
};

/** A validated backup, ready to be written table by table from its source. */
export type PreparedRestore = {
	source: BackupSource;
	tables: PreparedRestoreTable[];
	/** The pre-0019 `message_bodies` table, merged into messages as they are restored. */
	legacyBodies: BackupTableRange | null;
	rowCount: number;
};
