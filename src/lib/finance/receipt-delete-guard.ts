import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { financeReceipts } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { fail, type FinanceAnswer } from "./manual-context";
import { onReceiptTablesOr } from "./receipt-tables";
import type { ReceiptSourceTable } from "./receipts";

export const RECEIPTS_IN_DRIVE_ERROR =
	"This also has saved copies in Drive under Money Watch/Receipts. Removing it keeps them in Drive.";

/**
 * "Deleting a finance row does not delete the Drive copy silently: ask" (docs/specs/money-watch.md "Keep
 * receipts"). Refuses with 409 `RECEIPTS_IN_DRIVE` unless `acknowledge` is true, the same shape as a
 * flagged-attachment refusal; the Drive files are never touched either way. Reads with `onReceiptTablesOr`:
 * before migration 0101 nothing can possibly be filed, so every other delete (which has nothing to do with Keep
 * receipts) must not start answering 409 `MIGRATION_PENDING` because of it.
 */
export async function receiptsDeleteGuard(
	sourceTable: ReceiptSourceTable,
	sourceIds: string[],
	acknowledge: boolean,
): Promise<FinanceAnswer | null> {
	if (acknowledge || sourceIds.length === 0) return null;
	const filed = await onReceiptTablesOr([], () =>
		getDb(getEnv())
			.select({ id: financeReceipts.id })
			.from(financeReceipts)
			.where(
				and(
					eq(financeReceipts.sourceTable, sourceTable),
					inArray(financeReceipts.sourceId, sourceIds),
					eq(financeReceipts.status, "done"),
				),
			)
			.limit(1),
	);
	if (filed.length === 0) return null;
	return fail(409, RECEIPTS_IN_DRIVE_ERROR, "RECEIPTS_IN_DRIVE");
}
