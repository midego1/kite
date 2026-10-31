import { authFetch } from "@/lib/auth/client";

/** `failed` is set when the provider refused the message: it is no longer held and can only be edited and sent again. */
export type SendNowOutcome = { ok: true } | { ok: false; error: string; failed: boolean };

/**
 * Asks the server to send a message held by the undo window right away. Any refusal (the queue got there first,
 * the account server asked to try later, a failure before the job was claimed) leaves the bar and its Undo in
 * place with the reason, since only a 200 says the message was delivered.
 */
export async function requestSendNow(messageId: string): Promise<SendNowOutcome> {
	try {
		const res = await authFetch(`/api/messages/${encodeURIComponent(messageId)}/send-now`, { method: "POST" });
		if (res.ok) return { ok: true };
		const data = (await res.json().catch(() => ({}))) as { error?: string; failed?: boolean };
		return { ok: false, error: data.error ?? "Could not send now", failed: data.failed === true };
	} catch {
		return { ok: false, error: "Could not send now", failed: false };
	}
}
