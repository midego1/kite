import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "@/db";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { canOmitMissingColumns, fillMissingColumns, isTableColumn, presentColumnKeys } from "./pending-columns-utils";

/** More columns than two releases add to a table; past this the error is not about a pending migration. */
const MAX_MISSING_COLUMNS = 8;

/**
 * The column a failed query names as missing, when retrying without it can work:
 * the table defines it and it has not been dropped already.
 */
function retryableMissingColumn(
	error: unknown,
	columns: Record<string, SQLiteColumn>,
	missing: ReadonlySet<string>,
): string | null {
	const column = missingColumnFromError(error);
	if (!column || missing.has(column) || !isTableColumn(columns, column)) return null;
	return missing.size < MAX_MISSING_COLUMNS ? column : null;
}

/**
 * `"table"."column"`, read through the column's own decoder. D1 accepts an unknown double-quoted bare name as a
 * string literal (SQLite's legacy quoting), so a missing `"chat_instructions"` would read as the text
 * "chat_instructions" instead of failing; a table-qualified name always fails, which is what the retry needs.
 */
function qualifiedColumn(table: SQLiteTable, column: SQLiteColumn) {
	return sql`${table}.${sql.identifier(column.name)}`.mapWith(column);
}

/**
 * Whole rows of `table`. A deploy runs before an admin applies its migrations, so a
 * column added to the table may not exist yet; the query is retried without it and
 * the column reads as its schema default, which keeps the pages and the mail
 * pipeline that read the table working in that window.
 */
export async function selectRows<T extends SQLiteTable>(
	db: AppDatabase,
	table: T,
	where?: SQL,
	limit?: number,
	orderBy?: SQL,
): Promise<T["$inferSelect"][]> {
	const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
	const missing = new Set<string>();
	let firstError: unknown;
	for (;;) {
		const selection = Object.fromEntries(
			presentColumnKeys(columns, missing).map((key) => [key, qualifiedColumn(table, columns[key])]),
		);
		try {
			const query = db
				.select(selection)
				.from(table as SQLiteTable)
				.where(where)
				.$dynamic();
			if (orderBy) query.orderBy(orderBy);
			const rows = (await (limit === undefined ? query : query.limit(limit))) as Record<string, unknown>[];
			return rows.map((row) => fillMissingColumns<T["$inferSelect"]>(row, columns, missing));
		} catch (error) {
			firstError ??= error;
			const column = retryableMissingColumn(error, columns, missing);
			if (!column) throw firstError;
			missing.add(column);
		}
	}
}

/** The first row `selectRows` finds, or undefined. */
export async function selectRow<T extends SQLiteTable>(
	db: AppDatabase,
	table: T,
	where?: SQL,
): Promise<T["$inferSelect"] | undefined> {
	const [row] = await selectRows(db, table, where, 1);
	return row;
}

function insertValue(column: SQLiteColumn, value: unknown): SQL {
	const resolved = value !== undefined ? value : column.defaultFn ? column.defaultFn() : column.default;
	return resolved === undefined || resolved === null ? sql`null` : sql`${sql.param(resolved, column)}`;
}

/**
 * Inserts one row. Before the migration that adds a column is applied, the insert
 * is retried without it, but only when the row would have stored the column's
 * default there; anything else still fails, since dropping the value would lose it.
 * With `ignoreConflict` an existing row with the same key is left alone.
 */
export async function insertRow<T extends SQLiteTable>(
	db: AppDatabase,
	table: T,
	values: T["$inferInsert"],
	options: { ignoreConflict?: boolean } = {},
): Promise<void> {
	try {
		const insert = db.insert(table).values(values);
		await (options.ignoreConflict ? insert.onConflictDoNothing() : insert);
		return;
	} catch (error) {
		const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
		const record = values as Record<string, unknown>;
		const missing = new Set<string>();
		let lastError: unknown = error;
		for (;;) {
			const column = retryableMissingColumn(lastError, columns, missing);
			if (!column) throw error;
			missing.add(column);
			if (!canOmitMissingColumns(record, columns, missing)) throw error;
			const keys = presentColumnKeys(columns, missing);
			const names = sql.join(
				keys.map((key) => sql.identifier(columns[key].name)),
				sql`, `,
			);
			const params = sql.join(
				keys.map((key) => insertValue(columns[key], record[key])),
				sql`, `,
			);
			try {
				const verb = options.ignoreConflict ? sql`insert or ignore` : sql`insert`;
				await db.run(sql`${verb} into ${table} (${names}) values (${params})`);
				return;
			} catch (retryError) {
				lastError = retryError;
			}
		}
	}
}
