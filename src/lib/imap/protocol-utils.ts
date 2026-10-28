import type { ImapAuthMethod, ImapTlsPlan } from "./types";

/** IMAP ports: implicit TLS on 993, STARTTLS on 143. */
export const IMAP_PORTS = [993, 143] as const;

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

/** Reads the UID out of an untagged FETCH response line, if it carries one. */
export function parseFetchUid(line: string): string | null {
	const match = line.match(/\bUID\s+(\d+)/i);
	return match ? match[1] : null;
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

/** The SASL PLAIN response (RFC 4616): base64 of NUL, the user name, NUL and the password, UTF-8 encoded. */
export function plainAuthToken(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`\0${username}\0${password}`);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
