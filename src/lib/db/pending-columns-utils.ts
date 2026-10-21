import type { PendingColumn } from "./pending-columns-types";

/**
 * The property keys of the columns a row may carry. A column the database does
 * not have yet is left out of the select; `missing` holds SQL column names.
 */
export function presentColumnKeys(columns: Record<string, PendingColumn>, missing: ReadonlySet<string>): string[] {
	return Object.entries(columns)
		.filter(([, column]) => !missing.has(column.name))
		.map(([key]) => key);
}

/** Whether `name` is one of the table's SQL column names, so a retry without it can help. */
export function isTableColumn(columns: Record<string, PendingColumn>, name: string): boolean {
	return Object.values(columns).some((column) => column.name === name);
}

/** A row read without some columns, with each missing column set to its schema default (or null). */
export function fillMissingColumns<T>(
	row: Record<string, unknown>,
	columns: Record<string, PendingColumn>,
	missing: ReadonlySet<string>,
): T {
	const filled: Record<string, unknown> = { ...row };
	for (const [key, column] of Object.entries(columns)) {
		if (missing.has(column.name)) filled[key] = column.default ?? null;
	}
	return filled as T;
}

/**
 * Whether an insert can drop the missing columns without losing anything: each
 * value it would have written there is unset or equal to the column default,
 * which is what the migration that adds the column fills in.
 */
export function canOmitMissingColumns(
	values: Record<string, unknown>,
	columns: Record<string, PendingColumn>,
	missing: ReadonlySet<string>,
): boolean {
	return Object.entries(columns).every(([key, column]) => {
		if (!missing.has(column.name)) return true;
		const value = values[key];
		return value === undefined || value === null || value === column.default;
	});
}
