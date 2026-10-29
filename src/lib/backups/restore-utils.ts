import type { DatabaseRecord } from "./types";
import type { RestoreBatchLimits, RestorePlan, RestoreProbe, RestoreSegment, RestoreStatement } from "./restore-types";

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

/** A statement the builder finished, with the metadata given for its last row. */
type BuiltInsert<M> = { statement: RestoreStatement; last: DatabaseRecord; meta: M | undefined };

/**
 * Builds a table's multi-row INSERT statements one row at a time, each under
 * the bound-parameter limit, so rows can be streamed in without holding the
 * table. `add` returns a statement whenever the previous rows are complete.
 */
export class TableInsertBuilder<M = undefined> {
	private columns: string[] = [];
	private rows: DatabaseRecord[] = [];
	private meta: M | undefined;

	constructor(
		private readonly table: string,
		private readonly targetColumns: Set<string> | null,
		private readonly options: TableInsertOptions = {},
	) {}

	add(row: DatabaseRecord, meta?: M): BuiltInsert<M> | null {
		const rowColumns = Object.keys(row).filter((column) => !this.targetColumns || this.targetColumns.has(column));
		const error = insertColumnsError(this.table, rowColumns.length);
		if (error) throw new Error(error);
		const rowsPerStatement = Math.min(
			Math.floor(MAX_BOUND_PARAMETERS / rowColumns.length),
			this.options.maxRowsPerStatement ?? Number.POSITIVE_INFINITY,
		);
		let built: BuiltInsert<M> | null = null;
		if (this.rows.length > 0 && (this.rows.length >= rowsPerStatement || !sameColumns(this.columns, rowColumns))) {
			built = this.finish();
		}
		this.columns = rowColumns;
		this.rows.push(row);
		this.meta = meta;
		return built;
	}

	finish(): BuiltInsert<M> | null {
		if (!this.rows.length) return null;
		const statement = createInsert(this.table, this.columns, this.rows, this.options.ignoreConflicts);
		const built = { statement, last: this.rows.at(-1)!, meta: this.meta };
		this.rows = [];
		return built;
	}
}

function insertColumnsError(table: string, columns: number): string | null {
	if (columns === 0) return `Backup contains an invalid ${table} record`;
	if (columns > MAX_BOUND_PARAMETERS) return `Backup ${table} records have more columns than a restore can insert`;
	return null;
}

/**
 * Why a restored row cannot be inserted, checked while the backup is validated so an unusable file fails before
 * anything is written: no column the table has, more columns than one statement can bind, or a value D1 cannot
 * bind (an object or array). Null when the row is fine.
 */
export function restoreRowError(table: string, row: unknown, columns: Set<string>): string | null {
	if (!row || typeof row !== "object" || Array.isArray(row)) return `Backup contains an invalid ${table} record`;
	const matching = Object.keys(row).filter((column) => columns.has(column));
	const error = insertColumnsError(table, matching.length);
	if (error) return error;
	const record = row as DatabaseRecord;
	if (matching.some((column) => typeof record[column] === "object" && record[column] !== null))
		return `Backup contains an invalid ${table} record`;
	return null;
}

/**
 * The restore's steps in order. The kept backup rows go in right after the `backups` table, so the safety backup
 * is listed again as early as possible; the legacy bodies right after the messages they fill.
 */
export function restoreSegments(plan: RestorePlan): RestoreSegment[] {
	const segments: RestoreSegment[] = [{ kind: "deletes" }];
	let kept = false;
	for (const table of plan.tables) {
		segments.push({ kind: "rows", table });
		if (table.name === "messages" && plan.legacyBodies)
			segments.push({ kind: "bodies", range: plan.legacyBodies, columns: table.columns });
		if (table.name === "backups") {
			segments.push({ kind: "kept" });
			kept = true;
		}
	}
	if (!kept) segments.push({ kind: "kept" });
	return segments;
}

/** The row a resumed restore looks for: its primary key, or every inserted column for a table without one. */
export function restoreProbe(
	table: string,
	row: DatabaseRecord,
	primaryKey: string[],
	columns: Set<string>,
): RestoreProbe {
	const keys = primaryKey.length ? primaryKey : Object.keys(row).filter((column) => columns.has(column));
	return {
		table,
		values: Object.fromEntries(keys.map((key) => [key, (row[key] ?? null) as RestoreProbe["values"][string]])),
	};
}

export function probeStatement(probe: RestoreProbe): RestoreStatement {
	const columns = Object.keys(probe.values);
	return {
		sql: `SELECT 1 AS found FROM ${quoteIdentifier(probe.table)} WHERE ${columns.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ")} LIMIT 1`,
		params: columns.map((column) => {
			const value = probe.values[column] ?? null;
			return typeof value === "boolean" ? Number(value) : value;
		}),
	};
}

const INVALID_BODY_MESSAGE = "Backup contains an invalid message_bodies record";
const LEGACY_BODY_FIELDS = ["text_body", "html_body", "raw_r2_key"] as const;

/** Why a `message_bodies` record cannot fill its message: it must be an object naming one. */
export function legacyBodyError(body: unknown): string | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return INVALID_BODY_MESSAGE;
	const record = body as DatabaseRecord;
	if (typeof record.message_id !== "string") return INVALID_BODY_MESSAGE;
	return LEGACY_BODY_FIELDS.some((field) => typeof record[field] === "object" && record[field] !== null)
		? INVALID_BODY_MESSAGE
		: null;
}

/**
 * Fills a restored message from its pre-0019 `message_bodies` record. Fields the message already has win, so
 * the update can run twice; null when the record has nothing to give or names no message.
 */
export function legacyBodyStatement(body: unknown, messageColumns: Set<string>): RestoreStatement | null {
	const error = legacyBodyError(body);
	if (error) throw new Error(error);
	const record = body as DatabaseRecord;
	const fields = LEGACY_BODY_FIELDS.filter((field) => field in record && messageColumns.has(field));
	if (!fields.length) return null;
	return {
		sql: `UPDATE messages SET ${fields.map((field) => `${quoteIdentifier(field)} = coalesce(${quoteIdentifier(field)}, ?)`).join(", ")} WHERE id = ?`,
		params: [...fields.map((field) => (record[field] ?? null) as string | number | null), record.message_id],
	};
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
