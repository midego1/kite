import type { InboundAttachment } from "./helpers-types";

function icsDate(date: Date): string {
	return date.toISOString().slice(0, 10).replace(/-/g, "");
}

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
	organizer?: string | null;
	rrule?: string;
	/** Writes DTSTART/DTEND as `VALUE=DATE` dates covering the UTC day of `start`. */
	allDay?: boolean;
	/** Writes DTSTART/DTEND as local times with this TZID, whatever it is called. */
	tzid?: string;
	/** Writes DURATION instead of DTEND. */
	duration?: string;
	/** Extra padding bytes, to build an oversize file. */
	padding?: number;
};

export function inviteAttachment(options: IcsOptions): InboundAttachment {
	const method = options.method ?? "REQUEST";
	const when = (name: "DTSTART" | "DTEND", value: Date) => {
		if (options.allDay) return `${name};VALUE=DATE:${icsDate(value)}`;
		if (options.tzid) return `${name};TZID=${options.tzid}:${icsStamp(value).replace("Z", "")}`;
		return `${name}:${icsStamp(value)}`;
	};
	const end = options.allDay
		? new Date(options.start.getTime() + 86_400_000)
		: new Date(options.start.getTime() + (options.minutes ?? 60) * 60_000);
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Kite e2e//EN",
		`METHOD:${method}`,
		"BEGIN:VEVENT",
		`UID:${options.uid}`,
		`SEQUENCE:${options.sequence ?? 0}`,
		`DTSTAMP:${icsStamp(new Date())}`,
		when("DTSTART", options.start),
		options.duration ? `DURATION:${options.duration}` : when("DTEND", end),
		`SUMMARY:${options.summary ?? "Planning"}`,
		...(options.organizer === null ? [] : [`ORGANIZER:mailto:${options.organizer ?? "alice@partner.test"}`]),
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
