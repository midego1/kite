import { getEnv } from "@/lib/cloudflare";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { Refusal } from "./answer-utils";

/** A decision the user's request cannot have, answered with its status instead of failing the call. */
export class FinanceRefusal extends Error {
	constructor(
		readonly status: Refusal["status"],
		message: string,
	) {
		super(message);
	}
}

export const MIGRATION_PENDING_ERROR = "Apply the pending database update first";

const FINANCE_TABLES = ["finance_subscriptions", "finance_charges"];

/**
 * Whether the Money Watch tables exist. It reads only `sqlite_master`, so it answers on a schema that is
 * behind; the names are bound so the statement itself never names a table that may be missing.
 */
export async function financeTablesReady(): Promise<boolean> {
	const row = await getEnv()
		.DB.prepare(
			`SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name IN (${FINANCE_TABLES.map(() => "?").join(", ")})`,
		)
		.bind(...FINANCE_TABLES)
		.first<{ present: number }>();
	return Number(row?.present ?? 0) === FINANCE_TABLES.length;
}

/**
 * Runs a query on the Money Watch tables; before migration 0063 it refuses with 409 instead of failing.
 * The no-such-table catch stays for a table that disappears between the check and the query.
 */
export async function onFinanceTables<T>(run: () => Promise<T>): Promise<T> {
	if (!(await financeTablesReady())) throw new FinanceRefusal(409, MIGRATION_PENDING_ERROR);
	try {
		return await run();
	} catch (error) {
		if (isNoSuchTableError(error)) throw new FinanceRefusal(409, MIGRATION_PENDING_ERROR);
		throw error;
	}
}

export function refusalOf(error: unknown): Refusal | null {
	return error instanceof FinanceRefusal ? { status: error.status, error: error.message } : null;
}
