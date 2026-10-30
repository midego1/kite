import { getEmailAddress } from "@/lib/email/address";
import type { NewMessageEvent, NewMessageNotificationParts } from "./message-realtime-types";

// Control and bidirectional-override characters, which could make a typed name pose as a different address.
const INVISIBLE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Who a new-mail notice is from, as "Name <address>": the display name is whatever the sender typed, so the real
 * address always stands beside it (upstream Mailflare #223). Just the address when there is no other name.
 */
export function notificationSender(event: Pick<NewMessageEvent, "from" | "fromName">): string {
	const address = getEmailAddress(event.from).trim() || event.from;
	const name = (event.fromName ?? "").replace(INVISIBLE, "").trim().slice(0, 120);
	return name && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : address;
}

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
	const sender = notificationSender(event);
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
