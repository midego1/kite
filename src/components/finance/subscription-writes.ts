"use client";

import toast from "react-hot-toast";
import { undoAction } from "@/components/agent/suggestion-card-actions";
import { showUndoToast } from "@/components/ui/undo-toast";
import { authFetch } from "@/lib/auth/client";

async function errorOf(response: Response, fallback: string): Promise<string> {
	const data = (await response.json().catch(() => null)) as { error?: string } | null;
	return data?.error || fallback;
}

type WriteResult = { actionId: string | null } | { error: string };

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
		if (!response.ok) return { error: await errorOf(response, fallback) };
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
