import type { ImapAuthMethod, ImapLimits, ImapTlsPlan } from "./types";

/** IMAP ports: implicit TLS on 993, STARTTLS on 143. */
export const IMAP_PORTS = [993, 143] as const;

const MB = 1024 * 1024;

/**
 * The limits of one IMAP connection. A Worker isolate has 128 MB of memory, so on Workers a message may be at most
 * 36 MB (a message at Gmail's 25 MB attachment limit, base64-encoded) and a FETCH batch 48 MB; the Node server
 * allows 64 MB and 96 MB. A message above the limit fails its batch: the job retries and then fails with the reason.
 * Every command gets three minutes, extended by the bytes that keep arriving at 64 KB/s or more, up to ten minutes.
 */
export function imapLimits(runtime: "node" | undefined): ImapLimits {
	const node = runtime === "node";
	return {
		literalBytes: (node ? 64 : 36) * MB,
		fetchBatchBytes: (node ? 96 : 48) * MB,
		lineBytes: 8 * MB,
		commandResponseBytes: 32 * MB,
		commandResponseLines: 200_000,
		commandTimeoutMs: 180_000,
		minBytesPerSecond: 64 * 1024,
		commandMaxMs: 600_000,
	};
}

export function quoteImapString(value: string): string {
	if (/[\r\n\0]/.test(value)) throw new Error("IMAP values cannot contain line breaks");
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function parseSearchUids(line: string): string[] {
	const match = line.match(/^\* SEARCH(?:\s+(.+))?$/i);
	if (!match?.[1]) return [];
	return match[1]
		.trim()
		.split(/\s+/)
		.filter((value) => /^\d+$/.test(value));
}

export function getLiteralLength(line: string): number | null {
	const match = line.match(/\{(\d+)\}$/);
	return match ? Number(match[1]) : null;
}

export function isTaggedCompletion(line: string, tag: string): boolean {
	return line.toUpperCase().startsWith(`${tag.toUpperCase()} `);
}

/** True when a tagged completion line reports OK (not NO or BAD). */
export function isTaggedOk(line: string, tag: string): boolean {
	return line.toUpperCase().startsWith(`${tag.toUpperCase()} OK`);
}

export function parseListMailboxName(line: string): string | null {
	const match = line.match(/^\* LIST\s+\([^\)]*\)\s+(?:"[^"]*"|NIL)\s+(.+)$/i);
	if (!match?.[1]) return null;
	const value = match[1].trim();
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	return value || null;
}

/** @public Exercised by the unit tests. Reads the UID out of an untagged FETCH response line, if it carries one. */
export function parseFetchUid(line: string): string | null {
	const match = line.match(/\bUID\s+(\d+)/i);
	return match ? match[1] : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * @public Exercised by the unit tests. An IMAP `date-time` (RFC 9051 §9: `dd-Mon-yyyy hh:mm:ss +zzzz`, the day possibly space-padded) as a Date, or
 * null when it is not one.
 */
export function parseInternalDate(value: string): Date | null {
	const match = value.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
	if (!match) return null;
	const [, day, monthName, year, hour, minute, second, sign, zoneHours, zoneMinutes] = match;
	const month = MONTHS.indexOf(monthName.toLowerCase());
	if (month < 0) return null;
	const utc = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second));
	const offset = (Number(zoneHours) * 60 + Number(zoneMinutes)) * (sign === "+" ? 1 : -1);
	const date = new Date(utc - offset * 60_000);
	// Date.UTC rolls 31-Feb over into March; such a value is not a date.
	if (Number.isNaN(date.getTime()) || new Date(utc).getUTCDate() !== Number(day) || Number(hour) > 23) return null;
	return date;
}

/**
 * The attributes of one FETCH response, from its text with the literals left out: `UID`, `FLAGS (…)`,
 * `INTERNALDATE "…"` and `RFC822.SIZE`, in any order. A missing FLAGS list is an empty one.
 */
export function parseFetchAttributes(text: string): {
	uid: string | null;
	flags: string[];
	internalDate: Date | null;
	size: number | null;
} {
	const flags = text.match(/\bFLAGS \(([^)]*)\)/i)?.[1];
	const internalDate = text.match(/\bINTERNALDATE "([^"]*)"/i)?.[1];
	const size = text.match(/\bRFC822\.SIZE (\d+)/i)?.[1];
	return {
		uid: parseFetchUid(text),
		flags: flags ? flags.trim().split(/\s+/).filter(Boolean) : [],
		internalDate: internalDate ? parseInternalDate(internalDate) : null,
		size: size ? Number(size) : null,
	};
}

/**
 * The capabilities a line announces, upper-cased: an untagged `* CAPABILITY …` response or a `[CAPABILITY …]`
 * response code (in the greeting or a tagged OK). Null when the line announces none.
 */
export function parseCapabilities(line: string): string[] | null {
	const match = line.match(/^\* CAPABILITY\s+(.+)$/i) ?? line.match(/\[CAPABILITY\s+([^\]]+)\]/i);
	if (!match?.[1]) return null;
	return match[1].trim().toUpperCase().split(/\s+/).filter(Boolean);
}

/** The server greeting: `* OK` (sign-in needed), `* PREAUTH` (already signed in) or anything else (refused). */
export function parseGreeting(line: string): "ok" | "preauth" | null {
	if (/^\* OK\b/i.test(line)) return "ok";
	if (/^\* PREAUTH\b/i.test(line)) return "preauth";
	return null;
}

/**
 * Whether and how a connection becomes encrypted before credentials are sent. An implicit TLS connection already
 * is. A STARTTLS connection upgrades when the server offers it; otherwise it is refused, except for a loopback fake
 * under the dev flag (`plainTextAllowed`). STARTTLS is only valid before sign-in, so a PREAUTH greeting on a plain
 * connection is refused too.
 */
export function planStartTls(input: {
	security: "tls" | "starttls";
	capabilities: readonly string[];
	preauth: boolean;
	plainTextAllowed: boolean;
}): ImapTlsPlan {
	if (input.security === "tls") return { action: "none" };
	if (input.plainTextAllowed && (input.preauth || !input.capabilities.includes("STARTTLS"))) return { action: "none" };
	if (input.preauth)
		return { action: "refuse", reason: "The IMAP server signed in before the connection was encrypted" };
	if (!input.capabilities.includes("STARTTLS"))
		return {
			action: "refuse",
			reason:
				"This IMAP server does not offer STARTTLS, and Kite sends passwords only over an encrypted connection. Use port 993 with TLS instead.",
		};
	return { action: "starttls" };
}

/**
 * `AUTHENTICATE PLAIN` when the server offers it (with the credentials on the command line under `SASL-IR`), else
 * `LOGIN`. A server that sets `LOGINDISABLED` and offers no PLAIN mechanism cannot take a password.
 */
export function chooseAuthMethod(capabilities: readonly string[]): ImapAuthMethod | null {
	if (capabilities.includes("AUTH=PLAIN")) return capabilities.includes("SASL-IR") ? "plain-ir" : "plain";
	if (capabilities.includes("LOGINDISABLED")) return null;
	return "login";
}

/**
 * One `LOGIN` argument: a quoted string when the value is printable ASCII, else a literal of its UTF-8 bytes (a
 * quoted string cannot carry a line break, and 8-bit characters in one are not allowed). NUL is never valid.
 */
export function imapLoginArgument(
	value: string,
): { kind: "quoted"; text: string } | { kind: "literal"; bytes: Uint8Array } {
	if (value.includes("\0")) throw new Error("IMAP user names and passwords cannot contain a NUL character");
	if (/^[\x20-\x7e]*$/.test(value)) return { kind: "quoted", text: quoteImapString(value) };
	return { kind: "literal", bytes: new TextEncoder().encode(value) };
}

/**
 * The SASL PLAIN response (RFC 4616): base64 of NUL, the user name, NUL and the password, UTF-8 encoded. A NUL inside
 * either value would shift the fields, so it is refused.
 */
export function plainAuthToken(username: string, password: string): string {
	if (username.includes("\0") || password.includes("\0"))
		throw new Error("IMAP user names and passwords cannot contain a NUL character");
	const bytes = new TextEncoder().encode(`\0${username}\0${password}`);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
