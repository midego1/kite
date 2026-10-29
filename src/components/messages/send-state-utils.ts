import type { Message } from "@/hooks/types";
import { formatUserDate } from "@/lib/time/utils";
import { getSendStateLabel, type SendState, type SendStateLabel } from "@/lib/messages/send-state-utils";

/** "Oct 30, 9:00 AM" in the user's time zone. */
export function formatSendTime(value: string): string {
	return formatUserDate(value, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The row badge of a queued or failed message; null for one that went out. */
export function getMessageSendLabel(
	message: Pick<Message, "sendState" | "createdAt">,
	now = Date.now(),
): SendStateLabel | null {
	return message.sendState ? getSendStateLabel(message.sendState, message.createdAt, formatSendTime, now) : null;
}

/**
 * The buttons the reader banner offers its viewer: Cancel send and Edit while delivery has not started, "Edit and
 * resend" and Move to Drafts after a failure, only Move to Drafts once a claimed send has stalled, and nothing to
 * anyone but the author or while delivery is under way.
 */
export function getSendBannerActions(state: SendState): "cancel" | "failed" | "stuck" | null {
	if (!state.own) return null;
	if (state.status === "failed") return "failed";
	if (state.cancellable) return "cancel";
	return state.stuckMinutes !== undefined ? "stuck" : null;
}
