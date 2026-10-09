import type { DatabaseRecord } from "./types";
import type { RestoreBatchLimits, RestorePlan, RestoreStatement, RestoreTablePlan } from "./restore-types";

/** D1 rejects a statement with more bound parameters than this. */
export const MAX_BOUND_PARAMETERS = 100;

/**
 * Sized to stay well inside D1's per-call duration and payload limits. A
 * restore whose statements fit in one batch runs as one transaction; larger
 * ones run batch by batch and rely on the pre-restore backup for rollback.
 */
export const DEFAULT_RESTORE_BATCH_LIMITS: RestoreBatchLimits = { maxStatements: 500, maxBytes: 4_000_000 };

function quoteIdentifier(name: string): string {
	return `\`${name.replaceAll("`", "``")}\``;
}

/**
 * Turns the tables of a validated backup into DELETE statements (children
 * first) followed by multi-row INSERT statements (parents first). Columns the
 * target table no longer has are dropped, so a backup taken before a column
 * was removed still restores.
 */
export function planRestoreStatements(tables: RestoreTablePlan[]): {
	deletes: RestoreStatement[];
	inserts: RestoreStatement[];
} {
	const deletes = [...tables]
		.reverse()
		.map((table) => ({ sql: `DELETE FROM ${quoteIdentifier(table.name)}`, params: [] }));
	const inserts: RestoreStatement[] = [];
	for (const table of tables) inserts.push(...planTableInserts(table));
	return { deletes, inserts };
}

export type TableInsertOptions = {
	/** INSERT OR IGNORE: rows that hit a constraint are skipped instead of failing the statement. */
	ignoreConflicts?: boolean;
	/** Caps rows per statement below what the bound-parameter limit allows. */
	maxRowsPerStatement?: number;
};

export function planTableInserts(table: RestoreTablePlan, options: TableInsertOptions = {}): RestoreStatement[] {
	const statements: RestoreStatement[] = [];
	let columns: string[] = [];
	let rows: DatabaseRecord[] = [];

	for (const row of table.rows) {
		const rowColumns = Object.keys(row).filter((column) => !table.columns || table.columns.has(column));
		if (rowColumns.length === 0) throw new Error(`Backup contains an invalid ${table.name} record`);
		if (rowColumns.length > MAX_BOUND_PARAMETERS)
			throw new Error(`Backup ${table.name} records have more columns than a restore can insert`);
		const rowsPerStatement = Math.min(
			Math.floor(MAX_BOUND_PARAMETERS / rowColumns.length),
			options.maxRowsPerStatement ?? Number.POSITIVE_INFINITY,
		);
		if (rows.length > 0 && (rows.length >= rowsPerStatement || !sameColumns(columns, rowColumns))) {
			statements.push(createInsert(table.name, columns, rows, options.ignoreConflicts));
			rows = [];
		}
		columns = rowColumns;
		rows.push(row);
	}
	if (rows.length > 0) statements.push(createInsert(table.name, columns, rows, options.ignoreConflicts));
	return statements;
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

/** Groups statements into consecutive batches that each respect the limits. */
export function chunkRestoreStatements(
	statements: RestoreStatement[],
	limits: RestoreBatchLimits = DEFAULT_RESTORE_BATCH_LIMITS,
): RestoreStatement[][] {
	const chunks: RestoreStatement[][] = [];
	let current: RestoreStatement[] = [];
	let currentBytes = 0;
	for (const statement of statements) {
		const bytes = estimateStatementBytes(statement);
		if (current.length > 0 && (current.length >= limits.maxStatements || currentBytes + bytes > limits.maxBytes)) {
			chunks.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(statement);
		currentBytes += bytes;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

export function createRestorePlan(
	statements: RestoreStatement[],
	rowCount: number,
	limits: RestoreBatchLimits = DEFAULT_RESTORE_BATCH_LIMITS,
): RestorePlan {
	const chunks = chunkRestoreStatements(statements, limits);
	return { statements, chunks, atomic: chunks.length <= 1, rowCount };
}

/** Adds statements that must run in the same final batch as the restore itself. */
export function appendToRestorePlan(
	plan: RestorePlan,
	statements: RestoreStatement[],
	limits: RestoreBatchLimits = DEFAULT_RESTORE_BATCH_LIMITS,
): RestorePlan {
	return createRestorePlan([...plan.statements, ...statements], plan.rowCount, limits);
}
