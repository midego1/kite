import type { AgentDraftState } from "@/lib/agent/approvals/types";

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

/** The card stops listening and polling once nothing about the draft can change any more. */
export function isFinalDraftState(state: AgentDraftState): boolean {
	return state.state === "sent" || state.state === "failed" || state.state === "unavailable";
}

/** Waits between looks at a send that is still in flight, then gives up (the next mail event looks again). */
export const SENDING_POLL_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
/** setTimeout cannot wait longer than this; a later schedule is looked at again after it. */
const MAX_REFRESH_DELAY_MS = 60 * 60 * 1_000;
const SCHEDULE_GRACE_MS = 3_000;

/**
 * Milliseconds until the card should look at the draft again on its own, or null for none. A scheduled send is
 * looked at once its time has passed; a send in flight is looked at a few times with growing waits
 * (`attempt` counts the looks already made).
 */
export function draftRefreshDelay(state: AgentDraftState, attempt: number, now: number): number | null {
	if (state.state === "scheduled") {
		const wait = Date.parse(state.scheduledAt) - now + SCHEDULE_GRACE_MS;
		return Number.isFinite(wait) ? Math.min(Math.max(wait, 1_000), MAX_REFRESH_DELAY_MS) : null;
	}
	if (state.state === "sending") return SENDING_POLL_DELAYS_MS[attempt] ?? null;
	return null;
}
