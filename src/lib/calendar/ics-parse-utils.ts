import { dateFromZonedFields, isValidTimeZone } from "@/lib/time/utils";

export const ICS_MAX_BYTES = 256 * 1024;

type IcsAttendee = { email: string; name: string | null; partstat: string | null };

export type IcsInvite = {
	method: string | null;
	uid: string;
	sequence: number;
	/** UTC instant. For all-day events, midnight UTC of the calendar date. */
	start: string;
	/** UTC instant, exclusive for all-day events. */
	end: string;
	allDay: boolean;
	/** IANA zone of DTSTART, or null for UTC and all-day events. */
	tz: string | null;
	summary: string;
	location: string;
	organizer: { email: string; name: string | null } | null;
	attendees: IcsAttendee[];
	/** The raw RRULE value; only the first occurrence is described by start and end. */
	rrule: string | null;
};

type IcsParseError = "too_large" | "no_event" | "missing_uid" | "invalid_time" | "unknown_timezone" | "floating_time";
export type IcsParseResult = { ok: true; invite: IcsInvite } | { ok: false; error: IcsParseError };

type Property = { name: string; params: Record<string, string>; value: string };

const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

class IcsError extends Error {
	constructor(readonly code: IcsParseError) {
		super(code);
	}
}

function unfold(text: string): string[] {
	return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function unescapeText(value: string): string {
	return value.replace(/\\([nN,;\\])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

function splitUnquoted(text: string, separator: string): string[] {
	const parts: string[] = [];
	let quoted = false;
	let current = "";
	for (const char of text) {
		if (char === '"') quoted = !quoted;
		if (char === separator && !quoted) {
			parts.push(current);
			current = "";
		} else current += char;
	}
	parts.push(current);
	return parts;
}

function parseProperty(line: string): Property | null {
	let quoted = false;
	let colon = -1;
	for (let index = 0; index < line.length; index++) {
		if (line[index] === '"') quoted = !quoted;
		else if (line[index] === ":" && !quoted) {
			colon = index;
			break;
		}
	}
	if (colon < 1) return null;
	const [name, ...rawParams] = splitUnquoted(line.slice(0, colon), ";");
	const params: Record<string, string> = {};
	for (const raw of rawParams) {
		const equals = raw.indexOf("=");
		if (equals > 0) params[raw.slice(0, equals).toUpperCase()] = raw.slice(equals + 1).replace(/^"|"$/g, "");
	}
	return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function parseAddress(property: Property): { email: string; name: string | null } | null {
	const email = property.value
		.replace(/^mailto:/i, "")
		.trim()
		.toLowerCase();
	if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
	return { email, name: property.params.CN?.trim() || null };
}

type DateParts = [number, number, number, number, number, number];

function parseDateParts(value: string): { parts: DateParts; utc: boolean; dateOnly: boolean } {
	const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
	if (!match) throw new IcsError("invalid_time");
	const numbers = match.slice(1, 7).map((part) => Number(part ?? 0));
	const parts = numbers as DateParts;
	const check = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
	if (check.getUTCMonth() !== parts[1] - 1 || check.getUTCDate() !== parts[2] || parts[3] > 23 || parts[4] > 59)
		throw new IcsError("invalid_time");
	return { parts, utc: match[7] === "Z", dateOnly: match[4] === undefined };
}

function resolveTimeZone(property: Property): string {
	const tzid = property.params.TZID?.trim() ?? "";
	if (!IANA_NAME.test(tzid) || !isValidTimeZone(tzid)) throw new IcsError("unknown_timezone");
	return tzid;
}

function parseInstant(property: Property): { time: number; allDay: boolean; tz: string | null } {
	const { parts, utc, dateOnly } = parseDateParts(property.value);
	const fields = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
	if (dateOnly || property.params.VALUE?.toUpperCase() === "DATE")
		return { time: Date.UTC(parts[0], parts[1] - 1, parts[2]), allDay: true, tz: null };
	if (utc) return { time: fields.getTime(), allDay: false, tz: null };
	if (!property.params.TZID) throw new IcsError("floating_time");
	const tz = resolveTimeZone(property);
	return { time: dateFromZonedFields(fields, tz).getTime(), allDay: false, tz };
}

function parseDurationMs(value: string): number {
	const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
	if (!match || value.trim().endsWith("P") || value.trim().endsWith("T")) throw new IcsError("invalid_time");
	const [weeks, days, hours, minutes, seconds] = match.slice(2, 7).map((part) => Number(part ?? 0));
	const sign = match[1];
	const total = (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000;
	return sign === "-" ? -total : total;
}

function firstEventProperties(lines: string[]): Property[] | null {
	const properties: Property[] = [];
	let inEvent = false;
	let nested = 0;
	for (const line of lines) {
		const upper = line.trim().toUpperCase();
		if (!inEvent) {
			inEvent = upper === "BEGIN:VEVENT";
			continue;
		}
		if (upper === "END:VEVENT" && nested === 0) return properties;
		if (upper.startsWith("BEGIN:")) nested++;
		else if (upper.startsWith("END:")) nested--;
		else if (nested === 0) {
			const property = parseProperty(line);
			if (property) properties.push(property);
		}
	}
	return null;
}

function method(lines: string[]): string | null {
	for (const line of lines) {
		if (line.trim().toUpperCase() === "BEGIN:VEVENT") break;
		const property = parseProperty(line);
		if (property?.name === "METHOD") return property.value.trim().toUpperCase() || null;
	}
	return null;
}

function resolveEnd(
	start: ReturnType<typeof parseInstant>,
	dtend: Property | undefined,
	duration: Property | undefined,
): number {
	if (dtend) {
		const end = parseInstant(dtend);
		if (end.allDay !== start.allDay || end.time < start.time) throw new IcsError("invalid_time");
		return end.time;
	}
	if (duration) {
		const ms = parseDurationMs(duration.value);
		if (ms < 0) throw new IcsError("invalid_time");
		return start.time + ms;
	}
	return start.time + (start.allDay ? 86_400_000 : 0);
}

function buildInvite(lines: string[], properties: Property[]): IcsInvite {
	const first = (name: string) => properties.find((property) => property.name === name);
	const text = (name: string) => unescapeText(first(name)?.value ?? "").trim();
	const uid = first("UID")?.value.trim();
	if (!uid) throw new IcsError("missing_uid");
	const dtstart = first("DTSTART");
	if (!dtstart) throw new IcsError("invalid_time");
	const start = parseInstant(dtstart);
	const end = resolveEnd(start, first("DTEND"), first("DURATION"));
	const sequence = Number.parseInt(first("SEQUENCE")?.value ?? "0", 10);
	const organizer = first("ORGANIZER");
	return {
		method: method(lines),
		uid,
		sequence: Number.isFinite(sequence) && sequence >= 0 ? sequence : 0,
		start: new Date(start.time).toISOString(),
		end: new Date(end).toISOString(),
		allDay: start.allDay,
		tz: start.tz,
		summary: text("SUMMARY"),
		location: text("LOCATION"),
		organizer: organizer ? parseAddress(organizer) : null,
		attendees: properties
			.filter((property) => property.name === "ATTENDEE")
			.flatMap((property) => {
				const address = parseAddress(property);
				return address ? [{ ...address, partstat: property.params.PARTSTAT?.toUpperCase() ?? null }] : [];
			}),
		rrule: first("RRULE")?.value.trim() || null,
	};
}

export function parseIcsInvite(source: string, maxBytes = ICS_MAX_BYTES): IcsParseResult {
	if (new TextEncoder().encode(source).length > maxBytes) return { ok: false, error: "too_large" };
	try {
		const lines = unfold(source);
		const properties = firstEventProperties(lines);
		if (!properties) return { ok: false, error: "no_event" };
		return { ok: true, invite: buildInvite(lines, properties) };
	} catch (error) {
		if (error instanceof IcsError) return { ok: false, error: error.code };
		throw error;
	}
}
