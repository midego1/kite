import { authFetch } from "@/lib/auth/client";

export type SendNowOutcome = { ok: true } | { ok: false; error: string };

/**
 * Asks the server to send a message held by the undo window right away. A 409 means the queue got there first,
 * which is the same outcome: the message is on its way once.
 */
export async function requestSendNow(messageId: string): Promise<SendNowOutcome> {
	try {
		const res = await authFetch(`/api/messages/${encodeURIComponent(messageId)}/send-now`, { method: "POST" });
		if (res.ok || res.status === 409) return { ok: true };
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		return { ok: false, error: data.error ?? "Could not send now" };
	} catch {
		return { ok: false, error: "Could not send now" };
	}
}
