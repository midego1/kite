import type { DatabaseRecord } from "./types";
import type { RestoreBatchLimits, RestoreStatement } from "./restore-types";

/**
 * The storage configuration says where this install's objects live right now. A backup's copy may name
 * stores whose credentials or contents differ, so a restore keeps the live rows when there are any and
 * restores the backup's only into an install that has none. The two tables move together: routes name stores.
 */
export const PRESERVED_ON_RESTORE = ["storage_stores", "storage_routes"] as const;

/** The tables a restore must leave untouched, given how many rows each preserved table has now. */
export function preservedRestoreTables(liveRowCounts: Partial<Record<string, number>>): Set<string> {
	const hasLiveRows = PRESERVED_ON_RESTORE.some((table) => (liveRowCounts[table] ?? 0) > 0);
	return new Set(hasLiveRows ? PRESERVED_ON_RESTORE : []);
}

/** D1 rejects a statement with more bound parameters than this. */
export const MAX_BOUND_PARAMETERS = 100;

/**
 * Sized to stay well inside D1's per-call duration and payload limits. A
 * restore whose statements fit in one batch runs as one transaction; larger
 * ones run batch by batch and rely on the pre-restore backup for rollback
 * (RestoreBatchWriter in restore-writer.ts).
 */
export const DEFAULT_RESTORE_BATCH_LIMITS: RestoreBatchLimits = { maxStatements: 500, maxBytes: 4_000_000 };

function quoteIdentifier(name: string): string {
	return `\`${name.replaceAll("`", "``")}\``;
}

/** Empties the given tables, children first; `tables` is in insert order, parents first. */
export function planRestoreDeletes(tables: string[]): RestoreStatement[] {
	return [...tables].reverse().map((table) => ({ sql: `DELETE FROM ${quoteIdentifier(table)}`, params: [] }));
}

type TableInsertOptions = {
	/** INSERT OR IGNORE: rows that hit a constraint are skipped instead of failing the statement. */
	ignoreConflicts?: boolean;
	/** Caps rows per statement below what the bound-parameter limit allows. */
	maxRowsPerStatement?: number;
};

/**
 * Builds a table's multi-row INSERT statements one row at a time, each under
 * the bound-parameter limit, so rows can be streamed in without holding the
 * table. `add` returns a statement whenever the previous rows are complete.
 */
export class TableInsertBuilder {
	private columns: string[] = [];
	private rows: DatabaseRecord[] = [];

	constructor(
		private readonly table: string,
		private readonly targetColumns: Set<string> | null,
		private readonly options: TableInsertOptions = {},
	) {}

	add(row: DatabaseRecord): RestoreStatement | null {
		const rowColumns = Object.keys(row).filter((column) => !this.targetColumns || this.targetColumns.has(column));
		if (rowColumns.length === 0) throw new Error(`Backup contains an invalid ${this.table} record`);
		if (rowColumns.length > MAX_BOUND_PARAMETERS)
			throw new Error(`Backup ${this.table} records have more columns than a restore can insert`);
		const rowsPerStatement = Math.min(
			Math.floor(MAX_BOUND_PARAMETERS / rowColumns.length),
			this.options.maxRowsPerStatement ?? Number.POSITIVE_INFINITY,
		);
		let statement: RestoreStatement | null = null;
		if (this.rows.length > 0 && (this.rows.length >= rowsPerStatement || !sameColumns(this.columns, rowColumns))) {
			statement = this.finish();
		}
		this.columns = rowColumns;
		this.rows.push(row);
		return statement;
	}

	finish(): RestoreStatement | null {
		if (!this.rows.length) return null;
		const statement = createInsert(this.table, this.columns, this.rows, this.options.ignoreConflicts);
		this.rows = [];
		return statement;
	}
}

function sameColumns(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((column, index) => column === right[index]);
}

function createInsert(
	table: string,
	columns: string[],
	rows: DatabaseRecord[],
	ignoreConflicts = false,
): RestoreStatement {
	const tuple = `(${columns.map(() => "?").join(", ")})`;
	return {
		sql: `INSERT${ignoreConflicts ? " OR IGNORE" : ""} INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES ${rows.map(() => tuple).join(", ")}`,
		params: rows.flatMap((row) => columns.map((column) => row[column] ?? null)),
	};
}

const encoder = new TextEncoder();

export function estimateStatementBytes(statement: RestoreStatement): number {
	let bytes = statement.sql.length;
	for (const param of statement.params) bytes += typeof param === "string" ? encoder.encode(param).byteLength : 8;
	return bytes;
}
