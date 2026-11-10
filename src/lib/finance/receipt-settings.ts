import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { financeReceiptSettings } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { onReceiptTables } from "./receipt-tables";

const db = () => getDb(getEnv());

/** "Keep receipts" for one owner; a missing row means on, the spec default. */
export async function receiptsEnabledFor(userId: string): Promise<boolean> {
	const [row] = await onReceiptTables(() =>
		db()
			.select({ enabled: financeReceiptSettings.enabled })
			.from(financeReceiptSettings)
			.where(eq(financeReceiptSettings.userId, userId))
			.limit(1),
	);
	return row?.enabled ?? true;
}

export async function setReceiptsEnabled(userId: string, enabled: boolean): Promise<void> {
	const now = new Date();
	await onReceiptTables(() =>
		db()
			.insert(financeReceiptSettings)
			.values({ userId, enabled, updatedAt: now })
			.onConflictDoUpdate({ target: financeReceiptSettings.userId, set: { enabled, updatedAt: now } }),
	);
}
