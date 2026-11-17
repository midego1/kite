import { useSyncExternalStore } from "react";
import toast from "react-hot-toast";
import type { UnsubscribeRouteResponse } from "@/app/api/messages/[messageId]/unsubscribe/types";
import { openUnsubscribeUrl } from "@/components/message-actions/utils";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { showActionToast } from "@/components/ui/undo-toast";
import { authFetch } from "@/lib/auth/client";
import { t } from "@/lib/i18n/translator";
import type { OneClickRun } from "./one-click-unsubscribe-types";

// Session-scoped, so the notice and the menu agree, and reopening the message does not offer it again.
const unsubscribed = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function markUnsubscribed(messageId: string) {
	unsubscribed.add(messageId);
	for (const listener of listeners) listener();
}

/** Whether this tab already unsubscribed from the list `messageId` came from. */
export function useUnsubscribed(messageId: string): boolean {
	return useSyncExternalStore(
		subscribe,
		() => unsubscribed.has(messageId),
		() => false,
	);
}

function limitOf(status: number, code: UnsubscribeRouteResponse["code"]): "rate" | "duplicate" | null {
	if (status !== 429) return null;
	return code === "ALREADY_REQUESTED" ? "duplicate" : "rate";
}

/** What the reader is told about a failed run. */
export function oneClickFailureText(run: Extract<OneClickRun, { status: "failed" }>): string {
	if (run.limited === "duplicate") return t("Kite already sent this unsubscribe request a few minutes ago.");
	if (run.limited === "rate") return t("Too many unsubscribe requests. Try again in a minute.");
	return t("Kite couldn't unsubscribe you automatically.");
}

/**
 * Asks first (one-click acts at once and cannot be taken back here), then has Kite send the RFC 8058 POST.
 * `fallbackUrl` is the link to offer when the server does not answer one of its own.
 */
export async function runOneClickUnsubscribe(messageId: string, fallbackUrl: string | null): Promise<OneClickRun> {
	const confirmed = await requestConfirmation({
		title: t("Unsubscribe from this list?"),
		description: t("Kite asks the sender to stop sending you this list. You don't need to open any link."),
		confirmLabel: t("Unsubscribe"),
	});
	if (!confirmed) return { status: "cancelled" };
	const loading = toast.loading(t("Unsubscribing…"));
	try {
		const response = await authFetch(`/api/messages/${encodeURIComponent(messageId)}/unsubscribe`, { method: "POST" });
		const data = (await response.json().catch(() => ({}))) as UnsubscribeRouteResponse;
		if (response.ok && data.unsubscribed) {
			markUnsubscribed(messageId);
			toast.success(t("You're unsubscribed. The sender may take a few days to stop."), { id: loading });
			return { status: "done" };
		}
		toast.dismiss(loading);
		const url = data.url === undefined ? fallbackUrl : data.url;
		return { status: "failed", url, limited: limitOf(response.status, data.code) };
	} catch {
		toast.dismiss(loading);
		return { status: "failed", url: fallbackUrl, limited: null };
	}
}

/** The menu's way to report a failure: a toast, with the sender's own page one click away when there is one. */
export function announceOneClickFailure(run: OneClickRun) {
	if (run.status !== "failed") return;
	const message = oneClickFailureText(run);
	const url = run.url;
	// Over the rate limit the answer is to wait; after a duplicate the sender's own page is still worth offering.
	if (!url || run.limited === "rate") {
		toast.error(message);
		return;
	}
	showActionToast(
		message,
		t("Open the unsubscribe page"),
		async () => openUnsubscribeUrl(url),
		t("Kite couldn't unsubscribe you automatically."),
	);
}
