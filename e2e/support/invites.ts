import type { InboundAttachment } from "./helpers-types";

function icsStamp(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

/** A day `daysAhead` days out at the given UTC hour, so conflicts never depend on when the suite runs. */
export function futureAt(daysAhead: number, hourUtc: number): Date {
	const date = new Date(Date.now() + daysAhead * 86_400_000);
	date.setUTCHours(hourUtc, 0, 0, 0);
	return date;
}

export type IcsOptions = {
	uid: string;
	start: Date;
	minutes?: number;
	method?: "REQUEST" | "CANCEL";
	sequence?: number;
	summary?: string;
	organizer?: string;
	rrule?: string;
	/** Extra padding bytes, to build an oversize file. */
	padding?: number;
};

export function inviteAttachment(options: IcsOptions): InboundAttachment {
	const method = options.method ?? "REQUEST";
	const end = new Date(options.start.getTime() + (options.minutes ?? 60) * 60_000);
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Kite e2e//EN",
		`METHOD:${method}`,
		"BEGIN:VEVENT",
		`UID:${options.uid}`,
		`SEQUENCE:${options.sequence ?? 0}`,
		`DTSTAMP:${icsStamp(new Date())}`,
		`DTSTART:${icsStamp(options.start)}`,
		`DTEND:${icsStamp(end)}`,
		`SUMMARY:${options.summary ?? "Planning"}`,
		`ORGANIZER:mailto:${options.organizer ?? "alice@partner.test"}`,
		...(options.rrule ? [`RRULE:${options.rrule}`] : []),
		...Array.from({ length: Math.ceil((options.padding ?? 0) / 70) }, (_, index) => `X-PAD-${index}:${"a".repeat(60)}`),
		"END:VEVENT",
		"END:VCALENDAR",
	];
	return {
		filename: "invite.ics",
		contentType: `text/calendar; method=${method}; charset=utf-8`,
		content: lines.join("\r\n"),
	};
}
