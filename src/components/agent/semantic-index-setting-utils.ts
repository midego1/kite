import { authFetch } from "@/lib/auth/client";
import type { AgentSettingsResponse } from "./types";

/** What the switch needs: its value and whether this user may change it. */
export type SemanticIndexState = { semanticIndex: boolean; canManage: boolean };

export async function loadSemanticIndexState(mailboxId: string): Promise<SemanticIndexState | null> {
	const response = await authFetch(`/api/agent/settings?mailboxId=${encodeURIComponent(mailboxId)}`);
	if (!response.ok) return null;
	const data = (await response.json()) as Pick<AgentSettingsResponse, "semanticIndex" | "canManage">;
	return { semanticIndex: data.semanticIndex !== false, canManage: data.canManage };
}

/** The message of a failed "Search by meaning" save, from the route's `{ error }` body. */
export async function semanticIndexSaveError(response: Response): Promise<string> {
	const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
	if (typeof body?.error === "string") return body.error;
	return response.status === 403
		? "Only people who manage this mailbox can change this."
		: "Could not save. Try again.";
}
