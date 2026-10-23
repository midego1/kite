import toast from "react-hot-toast";
import { authFetch } from "@/lib/auth/client";
import { showUndoToast } from "@/components/ui/undo-toast";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import type {
	ScreenerDecision,
	ScreenerDecisionResult,
	ScreenerMessageStatus,
	ScreenerOverview,
	ScreenerSettingsPatch,
} from "@/lib/screener/screener-types";

async function readJson<T>(response: Response, fallback: string): Promise<T> {
	const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
	if (!response.ok || !data) throw new Error(data?.error ?? fallback);
	return data;
}

function messagesChanged() {
	window.dispatchEvent(new Event("kite:messages-changed"));
}

export async function fetchScreenerOverview(mailboxId: string): Promise<ScreenerOverview> {
	const params = new URLSearchParams({ mailboxId });
	return readJson(await authFetch(`/api/screener?${params}`), "Could not load the Screener");
}

export async function saveScreenerSettings(mailboxId: string, patch: ScreenerSettingsPatch): Promise<ScreenerOverview> {
	const overview = await readJson<ScreenerOverview>(
		await authFetch("/api/screener", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId, ...patch }),
		}),
		"Could not save the Screener settings",
	);
	messagesChanged();
	return overview;
}

export async function fetchScreenerMessageStatus(messageId: string): Promise<ScreenerMessageStatus | null> {
	const params = new URLSearchParams({ messageId });
	const response = await authFetch(`/api/screener/message?${params}`);
	if (!response.ok) return null;
	return (await response.json()) as ScreenerMessageStatus;
}

async function postDecision(mailboxId: string, address: string, decision: ScreenerDecision) {
	return readJson<ScreenerDecisionResult>(
		await authFetch("/api/screener/senders", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId, address, decision }),
		}),
		decision === "approved" ? "Could not approve the sender" : "Could not deny the sender",
	);
}

export async function forgetScreenerSender(mailboxId: string, address: string, restoreMessageIds: string[] = []) {
	await readJson(
		await authFetch("/api/screener/senders", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId, address, restoreMessageIds }),
		}),
		"Could not remove the sender",
	);
	messagesChanged();
}

export async function approveEveryoneWrittenTo(mailboxId: string): Promise<{ approved: number; released: number }> {
	const result = await readJson<{ approved: number; released: number }>(
		await authFetch("/api/screener/approve-sent", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId }),
		}),
		"Could not approve the people you have written to",
	);
	messagesChanged();
	return result;
}

/** Approve with an undo toast, or deny after a confirmation. Resolves false when nothing changed. */
export async function decideScreenerSender(
	mailboxId: string,
	address: string,
	decision: ScreenerDecision,
): Promise<boolean> {
	if (
		decision === "denied" &&
		!(await requestConfirmation({
			title: `Deny ${address}?`,
			description:
				"Their messages move to Spam and future mail from them is blocked. You can undo this in Settings, Inbox, Screener.",
			confirmLabel: "Deny",
		}))
	)
		return false;
	try {
		const result = await postDecision(mailboxId, address, decision);
		messagesChanged();
		if (decision === "approved")
			showUndoToast(`Approved ${address}`, () => forgetScreenerSender(mailboxId, address, result.movedMessageIds));
		else toast.success(`Denied ${address}`);
		return true;
	} catch (error) {
		toast.error(error instanceof Error ? error.message : "Could not update the sender");
		return false;
	}
}
