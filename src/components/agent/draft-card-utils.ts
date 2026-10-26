import type { AgentDraftState } from "../../lib/agent/approvals/draft-state-utils";

export type FinishedDraftState = Exclude<AgentDraftState, { state: "draft" } | { state: "unavailable" }>;

export function isFinishedDraftState(state: AgentDraftState): state is FinishedDraftState {
	return state.state === "sent" || state.state === "scheduled" || state.state === "sending" || state.state === "failed";
}

export function draftStateHeading(state: FinishedDraftState, formatTime: (iso: string) => string): string {
	if (state.state === "scheduled") return `Scheduled for ${formatTime(state.scheduledAt)}`;
	if (state.state === "sending") return "Sending…";
	return state.state === "failed" ? "Sending failed" : "Sent";
}

export const DRAFT_UNAVAILABLE_TEXT = "This draft is no longer available.";
