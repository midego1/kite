type CalendarInvitationInput = {
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	uid: string;
	method?: "REQUEST" | "CANCEL";
};

function escapeCalendarText(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function formatCalendarDate(value: Date): string {
	return value
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

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

/** Fold at 75 octets without splitting a UTF-8 sequence. */
function foldCalendarLine(line: string): string {
	const encoder = new TextEncoder();
	const parts: string[] = [];
	let current = "";
	let size = 0;
	for (const char of line) {
		const bytes = encoder.encode(char).length;
		if (size + bytes > (parts.length ? 74 : 75)) {
			parts.push(current);
			current = "";
			size = 0;
		}
		current += char;
		size += bytes;
	}
	parts.push(current);
	return parts.join("\r\n ");
}

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
		`DTSTAMP:${formatCalendarDate(input.now ?? new Date())}`,
		`SEQUENCE:${Math.max(0, Math.trunc(input.sequence))}`,
		`ORGANIZER:mailto:${assertSingleLine(input.organizer)}`,
		`ATTENDEE;PARTSTAT=${input.partstat}${name ? `;CN="${name}"` : ""}:mailto:${assertSingleLine(input.attendee)}`,
	];
	if (input.startsAt) lines.push(`DTSTART:${formatCalendarDate(input.startsAt)}`);
	if (input.endsAt) lines.push(`DTEND:${formatCalendarDate(input.endsAt)}`);
	if (input.summary) lines.push(`SUMMARY:${escapeCalendarText(input.summary)}`);
	lines.push("END:VEVENT", "END:VCALENDAR");
	return new TextEncoder().encode(lines.map(foldCalendarLine).join("\r\n")).buffer;
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
		`DTSTAMP:${formatCalendarDate(new Date())}`,
		`DTSTART:${formatCalendarDate(input.startsAt)}`,
		`DTEND:${formatCalendarDate(input.endsAt)}`,
		`SUMMARY:${escapeCalendarText(input.title)}`,
		`DESCRIPTION:${escapeCalendarText(input.description)}`,
		`LOCATION:${escapeCalendarText(input.location)}`,
		"END:VEVENT",
		"END:VCALENDAR",
	];
	return new TextEncoder().encode(lines.join("\r\n")).buffer;
}
