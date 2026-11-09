import { answering, fail, ok, type FinanceAnswer, type FinanceUser } from "./manual-context";
import { backfillView, ownerBackfill, startReceiptBackfill } from "./receipt-backfill";
import { receiptsEnabledFor, setReceiptsEnabled } from "./receipt-settings";

/** `GET /api/finance/receipts`: the "Keep receipts" setting and the state of its backfill, if any. */
export function getReceiptSettings(user: FinanceUser): Promise<FinanceAnswer> {
	return answering(async () =>
		ok({ enabled: await receiptsEnabledFor(user.id), backfill: backfillView(await ownerBackfill(user.id)) }),
	);
}

/** `PATCH /api/finance/receipts` `{ enabled }`: turns "Keep receipts" on or off for the signed-in user. */
export function updateReceiptSettings(user: FinanceUser, body: unknown): Promise<FinanceAnswer> {
	return answering(async () => {
		const value = (body ?? {}) as { enabled?: unknown };
		if (typeof value.enabled !== "boolean") return fail(400, "enabled must be true or false");
		await setReceiptsEnabled(user.id, value.enabled);
		return ok({ enabled: value.enabled });
	});
}

/** `POST /api/finance/receipts/backfill`: starts "Save receipts for existing payments" (or reports the running one). */
export function startReceiptsBackfill(user: FinanceUser): Promise<FinanceAnswer> {
	return answering(async () => ok({ backfill: backfillView(await startReceiptBackfill(user.id)) }));
}
