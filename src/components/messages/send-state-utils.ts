import type { Message } from "@/hooks/types";
import { formatUserDate } from "@/lib/time/utils";
import { getSendStateLabel, type SendStateLabel } from "@/lib/messages/send-state-utils";

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
