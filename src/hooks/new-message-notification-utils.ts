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

/** A six-digit sample code for the Settings test. A new one each time, so a paste shows the right one was copied. */
export function makeTestOneTimeCode(random: () => number = Math.random): string {
	return String(100_000 + Math.floor(random() * 900_000));
}

/** The Settings test code notification, shaped exactly like a real one-time code notification. */
export function buildTestCodeNotificationParts(code: string): NewMessageNotificationParts {
	return buildNewMessageNotificationParts(
		{
			type: "new_message",
			messageId: "",
			mailboxId: "",
			from: "Kite",
			fromName: "Kite",
			subject: "Test sign-in code",
			oneTimeCode: code,
		},
		true,
	);
}
