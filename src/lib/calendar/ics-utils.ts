import { zonedWallClock } from "./zone-offset-utils";

/** Shared iCalendar (RFC 5545) writing helpers for the subscription feed, outgoing invitations and invitation replies. */

/**
 * TEXT value escaping (RFC 5545 section 3.3.11). Control characters other than tab and line breaks are dropped, and
 * every line-break form (CRLF, CR, LF) becomes the `\n` escape: a bare CR left in the output would let event text
 * start a new property line.
 */
export function escapeIcsText(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds a content line at 75 octets with CRLF + space (RFC 5545 section 3.1), never splitting a UTF-8 sequence. */
const encoder = new TextEncoder();
const NON_ASCII = /[^\u0000-\u007f]/;

/** The UTF-8 length of a line, without encoding it when it is plain ASCII (nearly every line of a feed). */
function octets(line: string): number {
	return NON_ASCII.test(line) ? encoder.encode(line).length : line.length;
}

export function foldIcsLine(line: string): string {
	if (octets(line) <= 75) return line;
	const parts: string[] = [];
	let current = "";
	let size = 0;
	for (const char of line) {
		const bytes = octets(char);
		// Continuation lines start with the folding space, so they carry 74 octets of content.
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

/** A UTC DATE-TIME value such as `20261104T170000Z`. */
export function formatIcsUtc(value: Date): string {
	return value
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

/** A local DATE-TIME value (no `Z`) as the wall clock shows it in `timeZone`, for a `TZID=` property. */
export function formatIcsLocal(value: Date, timeZone: string): string {
	return formatIcsUtc(zonedWallClock(value.getTime(), timeZone)).slice(0, 15);
}

/** Folds every line and joins them with CRLF, ending with the trailing CRLF the RFC requires. */
export function joinIcsLines(lines: string[]): string {
	return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}
