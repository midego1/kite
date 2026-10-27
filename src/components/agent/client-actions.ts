import { authFetch } from "@/lib/auth/client";
import { fetchDraft } from "@/components/compose/utils";
import type { ReviewSnapshot } from "./send-review-types";
import type { AgentDraftState } from "@/lib/agent/approvals/types";

/** Opens a send review of the draft at `expectedRevision`, or as it is now when none is given. */
export async function requestDraftReview(
	draftId: string,
	expectedRevision?: number,
): Promise<{ approvalId: string; snapshot: ReviewSnapshot }> {
	expectedRevision ??= (await fetchDraft(draftId)).agent?.revision;
	if (!expectedRevision) throw new Error("AI draft metadata is missing");
	const response = await authFetch("/api/agent/approvals", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ draftId, expectedRevision }),
	});
	const result = (await response.json()) as { approvalId?: string; snapshot?: ReviewSnapshot; error?: string };
	if (!response.ok || !result.approvalId || !result.snapshot)
		throw new Error(result.error || "Could not open draft review");
	return { approvalId: result.approvalId, snapshot: result.snapshot };
}

export async function approveAgentAction(toolMessageId: string): Promise<Record<string, unknown>> {
	const response = await authFetch("/api/agent/actions/confirm", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ toolMessageId }),
	});
	const result = (await response.json()) as Record<string, unknown>;
	if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Could not approve action");
	return result;
}

export async function fetchAgentDraftState(draftId: string): Promise<AgentDraftState> {
	const response = await authFetch(`/api/drafts/${encodeURIComponent(draftId)}/state`);
	const result = (await response.json()) as AgentDraftState & { error?: string };
	if (!response.ok) throw new Error(result.error || "Could not load draft status");
	return result;
}

export async function undoApprovedAgentAction(toolMessageId: string): Promise<Record<string, unknown>> {
	const response = await authFetch("/api/agent/actions/chat-undo", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ toolMessageId }),
	});
	const result = (await response.json()) as Record<string, unknown>;
	if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Could not undo action");
	return result;
}
