import type { DatabaseRecord } from "./types";

export type RestoreStatement = { sql: string; params: (string | number | null)[] };

export type RestoreTablePlan = {
	name: string;
	rows: DatabaseRecord[];
	/** Columns the target table has; null keeps every column of the backup row. */
	columns: Set<string> | null;
};

export type RestoreBatchLimits = { maxStatements: number; maxBytes: number };

export type RestorePlan = {
	statements: RestoreStatement[];
	chunks: RestoreStatement[][];
	atomic: boolean;
	rowCount: number;
};

export type RestoreOutcome = {
	atomic: boolean;
	safetyBackupId: string | null;
	rowCount: number;
};
