import { authFetch } from "@/lib/auth/client";
import type { ConfirmOptions } from "@/components/ui/confirm-dialog-types";
import type { AgentSettingsResponse } from "./types";

/** What the switch needs: its value, whether it can be saved yet (migration 0091) and whether this user may. */
export type MailboxAiState = { aiDisabled: boolean; ready: boolean; canManage: boolean };

export async function loadMailboxAiState(mailboxId: string): Promise<MailboxAiState | null> {
	const response = await authFetch(`/api/agent/settings?mailboxId=${encodeURIComponent(mailboxId)}`);
	if (!response.ok) return null;
	const data = (await response.json()) as Pick<AgentSettingsResponse, "aiDisabled" | "aiSwitchReady" | "canManage">;
	return { aiDisabled: data.aiDisabled === true, ready: data.aiSwitchReady === true, canManage: data.canManage };
}

/** The message of a failed "No AI for this mailbox" save, from the route's `{ error }` body. */
export async function mailboxAiSaveError(response: Response): Promise<string> {
	const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
	if (typeof body?.error === "string") return body.error;
	return response.status === 403
		? "Only people who manage this mailbox can change this."
		: "Could not save. Try again.";
}

/** The question before turning AI off for a mailbox: it deletes what AI made there, which cannot be undone. */
export function mailboxAiConfirmation(address: string): ConfirmOptions {
	return {
		title: `Turn off AI for ${address}?`,
		description:
			"Kite will send nothing from this mailbox to an AI provider, for everyone who can open it. Its summaries and one-line summaries are deleted, open suggestions are closed and queued AI work stops. You can turn AI back on later; deleted summaries do not come back.",
		confirmLabel: "Turn off AI",
	};
}
