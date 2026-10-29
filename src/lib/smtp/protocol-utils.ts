import type { SmtpAuthMethod, SmtpExtensions, SmtpLimits, SmtpReply, SmtpStage, SmtpTlsPlan } from "./types";

/** SMTP submission ports: implicit TLS on 465, STARTTLS on 587. */
export const SMTP_PORTS = [465, 587] as const;

/** The longest server reply text an error carries (spec §7.3). */
const REPLY_TEXT_MAX = 300;

/**
 * The limits of one SMTP connection. Replies are short (RFC 5321 §4.5.3.1.5 allows 512 octets a line), so a line is
 * capped at 16 KB and a reply at 1,000 lines. Commands wait two minutes, as long as RFC 5321 §4.5.3.2 suggests for the
 * DATA command; the end of the message gets its ten minutes.
 */
export function smtpLimits(): SmtpLimits {
	return { lineBytes: 16 * 1024, replyLines: 1000, commandTimeoutMs: 120_000, dataTimeoutMs: 600_000 };
}

/**
 * One reply line: `250-…` continues the reply, `250 …` (or a bare `250`) ends it. Null when the line is not an SMTP
 * reply (a code outside 2xx–5xx included), which ends the connection.
 */
export function parseReplyLine(line: string): { code: number; final: boolean; text: string } | null {
	const match = /^([2-5]\d\d)(?:([ -])(.*))?$/.exec(line);
	if (!match) return null;
	return { code: Number(match[1]), final: match[2] !== "-", text: match[3] ?? "" };
}

/** A complete reply from its lines. The code is the last line's; the enhanced code is read from the first. */
export function buildReply(lines: { code: number; text: string }[]): SmtpReply {
	const last = lines[lines.length - 1];
	const enhancedCode = /^([245]\.\d{1,3}\.\d{1,3})(?:\s|$)/.exec(lines[0]?.text ?? "")?.[1] ?? null;
	return { code: last?.code ?? 0, enhancedCode, lines: lines.map((line) => line.text) };
}

/** @public Exercised by the unit tests. The reply as one line of text, whitespace collapsed, cut to 300 characters. */
export function replyText(reply: SmtpReply): string {
	const text = `${reply.code} ${reply.lines.join(" ")}`.replace(/\s+/g, " ").trim();
	return text.length > REPLY_TEXT_MAX ? `${text.slice(0, REPLY_TEXT_MAX - 1)}…` : text;
}

/**
 * The EHLO answer's extensions. The first line is the server's name; each further line is a keyword with parameters.
 * Some servers still announce `AUTH=LOGIN PLAIN` (obsolete), which counts as `AUTH`.
 */
export function parseEhloExtensions(reply: SmtpReply): SmtpExtensions {
	const keywords: string[] = [];
	const auth = new Set<string>();
	let size: number | null = null;
	for (const line of reply.lines.slice(1)) {
		const [rawKeyword = "", ...params] = line.trim().split(/\s+/);
		const keyword = rawKeyword.toUpperCase();
		if (!keyword) continue;
		if (keyword === "AUTH" || keyword.startsWith("AUTH=")) {
			const mechanisms = keyword === "AUTH" ? params : [keyword.slice(5), ...params];
			for (const mechanism of mechanisms) if (mechanism) auth.add(mechanism.toUpperCase());
			if (keyword === "AUTH") keywords.push(keyword);
			continue;
		}
		if (keyword === "SIZE") {
			const limit = Number(params[0]);
			size = Number.isSafeInteger(limit) && limit > 0 ? limit : null;
		}
		keywords.push(keyword);
	}
	return { keywords: [...new Set(keywords)], auth: [...auth], size };
}

/**
 * Whether and how the connection becomes encrypted before credentials are sent: implicit TLS already is; a STARTTLS
 * connection upgrades when the server offers it and is refused otherwise, except for a loopback fake under the dev
 * flag (`plainTextAllowed`).
 */
export function planSmtpStartTls(input: {
	security: "tls" | "starttls";
	extensions: SmtpExtensions;
	plainTextAllowed: boolean;
}): SmtpTlsPlan {
	if (input.security === "tls") return { action: "none" };
	if (input.extensions.keywords.includes("STARTTLS")) return { action: "starttls" };
	if (input.plainTextAllowed) return { action: "none" };
	return {
		action: "refuse",
		reason:
			"This SMTP server does not offer STARTTLS, and Kite sends passwords only over an encrypted connection. Use port 465 with TLS instead.",
	};
}

/** `AUTH PLAIN` when offered, else `AUTH LOGIN`; null when the server takes neither (or no password at all). */
export function chooseSmtpAuthMethod(mechanisms: readonly string[]): SmtpAuthMethod | null {
	if (mechanisms.includes("PLAIN")) return "plain";
	if (mechanisms.includes("LOGIN")) return "login";
	return null;
}

/** Base64 of the UTF-8 bytes of `value`. */
export function base64Utf8(value: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * The SASL PLAIN response (RFC 4616) for `AUTH PLAIN`: base64 of NUL, the user name, NUL and the password. A NUL inside
 * either value would shift the fields, and a line break could end the command, so both are refused.
 */
export function smtpPlainToken(username: string, password: string): string {
	assertCredential(username, password);
	return base64Utf8(`\0${username}\0${password}`);
}

/** Refuses user names and passwords SMTP cannot carry. The message never contains either value. */
export function assertCredential(username: string, password: string): void {
	if (/[\0\r\n]/.test(username) || /[\0\r\n]/.test(password))
		throw new Error("SMTP user names and passwords cannot contain NUL or line break characters");
}

/** Replaces every secret (and its base64 form) in a server reply, so an echoing server cannot put one in an error. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
	let result = text;
	for (const secret of secrets) {
		if (secret.length < 3) continue;
		for (const form of [secret, base64Utf8(secret)]) result = result.split(form).join("[redacted]");
	}
	return result;
}

/**
 * An address for `MAIL FROM` or `RCPT TO` (and the MIME headers): a bare `local@domain` or one inside `Name <…>`, with
 * an internationalized domain turned into its ASCII (punycode) form. Refused: anything that could break the command
 * (spaces, angle brackets, control characters), quoted or non-ASCII local parts (they need SMTPUTF8), and more than
 * RFC 5321's 64 octets of local part or 254 of address.
 */
export function transportAddress(value: string): string {
	const trimmed = value.trim();
	const inner = /<([^<>]*)>$/.exec(trimmed)?.[1] ?? trimmed;
	const at = inner.lastIndexOf("@");
	const local = inner.slice(0, at);
	const domain = inner.slice(at + 1);
	if (at <= 0 || !domain || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(local) || local.length > 64)
		throw new Error(`"${printable(inner)}" is not an address mail can be sent to`);
	if (/^\.|\.\.|\.$/.test(local)) throw new Error(`"${printable(inner)}" is not an address mail can be sent to`);
	const asciiDomain = asciiHostname(domain);
	if (!asciiDomain) throw new Error(`"${printable(inner)}" is not an address mail can be sent to`);
	const address = `${local}@${asciiDomain}`;
	if (address.length > 254) throw new Error("The address is longer than mail servers accept");
	return address;
}

/** The domain in lower-case ASCII (punycode for an internationalized name), or null when it is not a host name. */
function asciiHostname(domain: string): string | null {
	if (/[\s\0-\x1f\x7f<>()[\]\\,;:"@/?#%]/.test(domain)) return null;
	try {
		const hostname = new URL(`http://${domain}/`).hostname;
		if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname) || hostname.split(".").some((label) => label.length > 63))
			return null;
		return hostname;
	} catch {
		return null;
	}
}

/** The value with control characters dropped and cut, for an error message. */
function printable(value: string): string {
	const clean = value.replace(/[\0-\x1f\x7f]/g, "");
	return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

/**
 * The bytes sent after `DATA`: every line ending made CRLF (a bare CR or LF is never sent, so the end-of-data marker
 * cannot be smuggled in as `\n.\n`), a dot at the start of a line doubled (RFC 5321 §4.5.2), a final CRLF added when the
 * message lacks one, then `.` CRLF. Two passes: count, then fill one buffer of exactly that size.
 */
export function smtpDataPayload(raw: Uint8Array): Uint8Array {
	const CR = 13;
	const LF = 10;
	const DOT = 46;
	const walk = (emit: (byte: number) => void) => {
		let lineStart = true;
		for (let index = 0; index < raw.length; index += 1) {
			const byte = raw[index];
			if (byte === CR || byte === LF) {
				if (byte === CR && raw[index + 1] === LF) index += 1;
				emit(CR);
				emit(LF);
				lineStart = true;
				continue;
			}
			if (lineStart && byte === DOT) emit(DOT);
			emit(byte);
			lineStart = false;
		}
		if (!lineStart) {
			emit(CR);
			emit(LF);
		}
		emit(DOT);
		emit(CR);
		emit(LF);
	};
	let length = 0;
	walk(() => {
		length += 1;
	});
	const out = new Uint8Array(length);
	let offset = 0;
	walk((byte) => {
		out[offset++] = byte;
	});
	return out;
}

/** True when the message has a byte outside 7-bit ASCII, so `MAIL FROM` should say `BODY=8BITMIME`. */
export function hasEightBitBytes(raw: Uint8Array): boolean {
	for (const byte of raw) if (byte > 127) return true;
	return false;
}

const STAGE_FAILURES: Record<SmtpStage, string> = {
	greeting: "The SMTP server refused the connection",
	ehlo: "The SMTP server refused the greeting",
	starttls: "The SMTP server refused to start TLS",
	auth: "SMTP sign-in failed",
	mail: "The SMTP server refused the sender",
	rcpt: "The SMTP server refused a recipient",
	data: "The SMTP server refused the message",
};

/** `SMTP sign-in failed: 535 5.7.8 Username and Password not accepted`, naming the recipient a RCPT failed for. */
export function smtpFailureMessage(stage: SmtpStage, reply: SmtpReply, recipient?: string): string {
	const what = stage === "rcpt" && recipient ? `The SMTP server refused the recipient ${recipient}` : null;
	return `${what ?? STAGE_FAILURES[stage]}: ${replyText(reply)}`;
}

/** The address literal Kite introduces itself with in EHLO: valid everywhere, and it says nothing about the install. */
export const SMTP_CLIENT_NAME = "[127.0.0.1]";
