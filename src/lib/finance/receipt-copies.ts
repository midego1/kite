import { and, eq, exists, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems } from "@/db/schema/drive";
import { financeReceipts } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";

/**
 * A `finance_receipts` row that stands for a Drive copy the owner may rely on: a `pending` claim (its run may
 * already have written some of the files, which are only recorded once the row is `done`), or a `done` row with
 * at least one of its recorded files still in `drive_items` (a purged file leaves no row; a trashed one can still
 * be restored). A `done` row whose files are all gone is kept as the claim that stops a re-filing, but no longer
 * counts as a copy, so the delete confirmation and the list flag do not promise files that no longer exist.
 */
export function receiptCopyExists(): SQL {
	return or(
		eq(financeReceipts.status, "pending"),
		and(
			eq(financeReceipts.status, "done"),
			exists(
				getDb(getEnv())
					.select({ one: sql`1` })
					.from(driveItems)
					.where(
						sql`${driveItems.id} IN (${financeReceipts.emlFileId}, ${financeReceipts.htmlFileId}, ${financeReceipts.pdfFileId}, ${financeReceipts.attachmentFileId})`,
					),
			),
		),
	)!;
}
