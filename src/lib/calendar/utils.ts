import { escapeIcsText, foldIcsLine, formatIcsUtc } from "./ics-utils";

type CalendarInvitationInput = {
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	uid: string;
	method?: "REQUEST" | "CANCEL";
};

type CalendarReplyInput = {
	/** The organizer's UID, kept byte for byte so their calendar can match the reply. */
	uid: string;
	organizer: string;
	attendee: string;
	attendeeName?: string | null;
	partstat: "ACCEPTED" | "DECLINED" | "TENTATIVE";
	sequence: number;
	summary?: string;
	startsAt?: Date;
	endsAt?: Date;
	now?: Date;
};

function assertSingleLine(value: string) {
	if (/[\u0000-\u001f]/.test(value)) throw new Error("Calendar values cannot contain control characters");
	return value;
}

export function createCalendarReply(input: CalendarReplyInput): ArrayBuffer {
	const name = input.attendeeName?.replace(/["\u0000-\u001f]/g, "").trim();
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Kite//Calendar//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:REPLY",
		"BEGIN:VEVENT",
		`UID:${assertSingleLine(input.uid)}`,
		`DTSTAMP:${formatIcsUtc(input.now ?? new Date())}`,
		`SEQUENCE:${Math.max(0, Math.trunc(input.sequence))}`,
		`ORGANIZER:mailto:${assertSingleLine(input.organizer)}`,
		`ATTENDEE;PARTSTAT=${input.partstat}${name ? `;CN="${name}"` : ""}:mailto:${assertSingleLine(input.attendee)}`,
	];
	if (input.startsAt) lines.push(`DTSTART:${formatIcsUtc(input.startsAt)}`);
	if (input.endsAt) lines.push(`DTEND:${formatIcsUtc(input.endsAt)}`);
	if (input.summary) lines.push(`SUMMARY:${escapeIcsText(input.summary)}`);
	lines.push("END:VEVENT", "END:VCALENDAR");
	return new TextEncoder().encode(lines.map(foldIcsLine).join("\r\n")).buffer;
}

export function createCalendarInvitation(input: CalendarInvitationInput): ArrayBuffer {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Kite//Calendar//EN",
		"CALSCALE:GREGORIAN",
		`METHOD:${input.method ?? "REQUEST"}`,
		"BEGIN:VEVENT",
		// The pre-rename suffix stays: updates and cancellations must carry the UID of the original invitation.
		`UID:${input.uid}@mailflare`,
		`DTSTAMP:${formatIcsUtc(new Date())}`,
		`DTSTART:${formatIcsUtc(input.startsAt)}`,
		`DTEND:${formatIcsUtc(input.endsAt)}`,
		`SUMMARY:${escapeIcsText(input.title)}`,
		`DESCRIPTION:${escapeIcsText(input.description)}`,
		`LOCATION:${escapeIcsText(input.location)}`,
		"END:VEVENT",
		"END:VCALENDAR",
	];
	return new TextEncoder().encode(lines.map(foldIcsLine).join("\r\n")).buffer;
}
