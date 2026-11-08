import { getEnv } from "@/lib/cloudflare";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { FinanceRefusal, MIGRATION_PENDING_ERROR } from "./errors";

const RECEIPT_TABLES = ["finance_receipts", "finance_receipt_settings", "finance_receipt_backfills"];

/** Whether migration 0101 ("Keep receipts") is applied; reads only `sqlite_master`. */
export async function receiptTablesReady(): Promise<boolean> {
	const { results } = await getEnv()
		.DB.prepare(
			`SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name IN (${RECEIPT_TABLES.map(() => "?").join(", ")})`,
		)
		.bind(...RECEIPT_TABLES)
		.all<{ present: number }>();
	return Number(results[0]?.present ?? 0) === RECEIPT_TABLES.length;
}

/** Runs a query on the receipt tables; before migration 0101 it refuses with 409 instead of failing. */
export async function onReceiptTables<T>(run: () => Promise<T>): Promise<T> {
	if (!(await receiptTablesReady())) throw new FinanceRefusal(409, MIGRATION_PENDING_ERROR);
	try {
		return await run();
	} catch (error) {
		if (isNoSuchTableError(error)) throw new FinanceRefusal(409, MIGRATION_PENDING_ERROR);
		throw error;
	}
}
