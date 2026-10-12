import type { NewMessageEvent, NewMessageNotificationParts } from "./message-realtime-types";

/**
 * Title and body for a new-mail browser notification. With a code (and the
 * per-browser code setting on) the code leads the title so it can be read at a
 * glance, and the body says a click copies it; without one the notification is
 * the classic "subject / From sender" shape.
 */
export function buildNewMessageNotificationParts(
	event: NewMessageEvent,
	showCodes: boolean,
): NewMessageNotificationParts {
	const sender = event.fromName ?? event.from;
	const code = showCodes ? event.oneTimeCode : null;
	if (code) {
		return {
			title: event.subject ? `${code} · ${event.subject}` : `Your code: ${code}`,
			body: `From ${sender} · Click to copy`,
			code,
		};
	}
	return { title: event.subject || "New email", body: `From ${sender}`, code: null };
}
