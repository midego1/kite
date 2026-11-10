"use client";

import toast from "react-hot-toast";
import { undoAction } from "@/components/agent/suggestion-card-actions";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { showUndoToast } from "@/components/ui/undo-toast";
import { authFetch } from "@/lib/auth/client";
import { t } from "@/lib/i18n/translator";

async function errorBodyOf(response: Response, fallback: string): Promise<{ error: string; code?: string }> {
	const data = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
	return { error: data?.error || fallback, code: data?.code };
}

type WriteResult = { actionId: string | null } | { error: string; code?: string };

/** One audited Money Watch write; the answer's `actionId` is what Undo reverts. */
export async function financeWrite(
	path: string,
	method: "POST" | "PATCH" | "DELETE",
	body?: unknown,
	fallback = "Could not save the change",
): Promise<WriteResult> {
	try {
		const response = await authFetch(path, {
			method,
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) return await errorBodyOf(response, fallback);
		const data = (await response.json().catch(() => ({}))) as { actionId?: string };
		return { actionId: data.actionId ?? null };
	} catch {
		return { error: fallback };
	}
}

/** The undo toast for a write that went through, refreshing the view once more after an undo. */
export function announceWrite(message: string, actionId: string | null, onChanged: () => void) {
	onChanged();
	if (!actionId) return;
	showUndoToast(message, async () => {
		await undoAction(actionId);
		onChanged();
	});
}

/** A write from a menu or button: errors become a toast, success the undo toast. */
export async function writeWithUndo(
	request: { path: string; method: "POST" | "PATCH" | "DELETE"; body?: unknown },
	message: string,
	onChanged: () => void,
): Promise<boolean> {
	const result = await financeWrite(request.path, request.method, request.body);
	if ("error" in result) {
		toast.error(result.error);
		return false;
	}
	announceWrite(message, result.actionId, onChanged);
	return true;
}

export const subscriptionPath = (id: string) => `/api/finance/subscriptions/${encodeURIComponent(id)}`;

function confirmReceiptsRemoval(): Promise<boolean> {
	return requestConfirmation({
		title: t("Remove this, even though it has saved copies in Drive?"),
		description: t(
			"“Keep receipts” already saved a copy of this mail to Drive, under Money Watch/Receipts. Removing this entry does not remove those files.",
		),
		confirmLabel: t("Remove"),
	});
}

/**
 * A delete that may have "Keep receipts" copies in Drive: asks first, since removing the finance row never
 * removes those files. `hasReceipts` comes from the row the list already fetched, so the common case asks
 * (and sends `acknowledge: true`) with no extra request; but a receipt the sweep filed after that list loaded
 * makes the server itself refuse with 409 `RECEIPTS_IN_DRIVE`, which is asked about and retried here rather
 * than acknowledging a delete the caller never actually confirmed.
 */
export async function removeWithReceiptsCheck(
	path: string,
	hasReceipts: boolean,
	message: string,
	onChanged: () => void,
): Promise<boolean> {
	if (hasReceipts && !(await confirmReceiptsRemoval())) return false;

	const result = await financeWrite(path, "DELETE", { acknowledge: hasReceipts });
	if ("error" in result) {
		if (result.code === "RECEIPTS_IN_DRIVE" && !hasReceipts) {
			if (!(await confirmReceiptsRemoval())) return false;
			return writeWithUndo({ path, method: "DELETE", body: { acknowledge: true } }, message, onChanged);
		}
		toast.error(result.error);
		return false;
	}
	announceWrite(message, result.actionId, onChanged);
	return true;
}
