import { hostname as osHostname } from "node:os";
import type { AuthenticateResult } from "mailauth";
import { parseAuthenticationResults } from "@/lib/spam/authentication-results-utils";

/** A value that may go into a header as it is: no spaces, separators, comments or quotes. */
const TOKEN = /^[^\s;()",\\]+$/;
const KEYWORD = /^[a-z]+$/;
const POLICIES = new Set(["none", "quarantine", "reject"]);

const token = (value: unknown): string | null => (typeof value === "string" && TOKEN.test(value) ? value : null);
const property = (name: string, value: unknown): string => {
	const safe = token(value);
	return safe ? ` ${name}=${safe}` : "";
};

function keyword(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const result = value === "temperr" ? "temperror" : value.toLowerCase();
	return KEYWORD.test(result) ? result : null;
}

/** The authserv-id Kite writes: `MAIL_HOSTNAME`, else the machine's name, else `kite`. */
export function smtpAuthservId(hostname: string | undefined): string {
	return token(hostname?.trim().toLowerCase()) ?? token(osHostname().toLowerCase()) ?? "kite";
}

function spfClause(spf: AuthenticateResult["spf"]): string[] {
	if (!spf) return [];
	const result = keyword(spf.status?.result);
	if (!result) return [];
	const mailfrom = property("smtp.mailfrom", spf.status?.smtp?.mailfrom ?? spf["envelope-from"]);
	return [`spf=${result}${mailfrom || property("smtp.helo", spf.status?.smtp?.helo ?? spf.helo)}`];
}

function dkimClauses(dkim: AuthenticateResult["dkim"] | undefined): string[] {
	if (!dkim) return [];
	const signatures = dkim.results ?? [];
	if (signatures.length === 0) return ["dkim=none"];
	return signatures.flatMap((signature) => {
		const result = keyword(signature.status?.result);
		return result
			? [`dkim=${result}${property("header.d", signature.signingDomain)}${property("header.s", signature.selector)}`]
			: [];
	});
}

function dmarcClause(dmarc: AuthenticateResult["dmarc"]): string[] {
	if (!dmarc) return [];
	const result = keyword(dmarc.status?.result);
	if (!result) return [];
	const policy = dmarc.policy?.toLowerCase();
	return [
		`dmarc=${result}${property("header.from", dmarc.status?.header?.from ?? dmarc.domain)}${policy && POLICIES.has(policy) ? ` policy.dmarc=${policy}` : ""}`,
	];
}

/**
 * The `Authentication-Results` value for mailauth's result, in the shape Cloudflare writes: SPF with
 * `smtp.mailfrom` (or `smtp.helo` for a null sender), one `dkim=` per signature with `header.d`, and DMARC with
 * `header.from` and the published policy as `policy.dmarc`. Text that is not a plain token is left out, so nothing
 * the sender chose can add a result. Null when no method gave one.
 */
export function authenticationResultsFromMailauth(result: AuthenticateResult, authservId: string): string | null {
	const results = [...spfClause(result.spf), ...dkimClauses(result.dkim), ...dmarcClause(result.dmarc)];
	return results.length ? [token(authservId) ?? "kite", ...results].join("; ") : null;
}

/** RFC 5322 date-time for a trace field. */
function traceDate(date: Date): string {
	return date.toUTCString().replace(/GMT$/, "+0000");
}

/**
 * The `Received` field the listener prepends (RFC 5321 §4.4): the HELO name as given, the connecting address as the
 * socket saw it, Kite's host name and the session id. Sender-chosen text that is not a plain token is left out, so
 * nothing the sender wrote can end the field or start another.
 */
export function trustedReceivedHeader(input: {
	helo?: string;
	remoteAddress: string;
	clientHostname?: string;
	by: string;
	secure: boolean;
	sessionId: string;
	date?: Date;
}): string {
	const helo = token(input.helo) ?? "unknown";
	const address = token(input.remoteAddress.replace(/^::ffff:/, "")) ?? "unknown";
	const reverse = token(input.clientHostname);
	const source = reverse && reverse !== `[${address}]` ? `${reverse} [${address}]` : `[${address}]`;
	const id = token(input.sessionId);
	return `Received: from ${helo} (${source}) by ${token(input.by) ?? "kite"} (Kite) with ${input.secure ? "ESMTPS" : "ESMTP"}${id ? ` id ${id}` : ""}; ${traceDate(input.date ?? new Date())}`;
}

/**
 * The message without any `Authentication-Results` field that carries Kite's own authserv-id (RFC 8601 §5): such a
 * field can only have been written by the sender, and left in place it would look like Kite's verdict to anyone
 * reading the source. Fields from other hosts and everything else stay byte for byte.
 */
export function stripOwnAuthenticationResults(raw: Buffer, authservId: string): Buffer {
	const text = raw.toString("latin1");
	const separator = /\r?\n(?=\r?\n)/.exec(text);
	if (!separator) return raw;
	// The header block with the last field's own line break, so every field keeps its ending and the blank line
	// that starts the body stays where it was, whichever field is removed.
	const end = separator.index + separator[0].length;
	const own = authservId.toLowerCase();
	const lines = text.slice(0, end).split(/(?<=\n)/);
	const kept: string[] = [];
	let dropping = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (/^[ \t]/.test(line)) {
			if (!dropping) kept.push(line);
			continue;
		}
		dropping = false;
		const match = /^authentication-results[ \t]*:(.*)$/is.exec(line);
		if (match) {
			let value = match[1];
			for (let next = index + 1; next < lines.length && /^[ \t]/.test(lines[next]); next += 1) value += lines[next];
			dropping = parseAuthenticationResults(value.replace(/\r?\n/g, "")).authservId === own;
		}
		if (!dropping) kept.push(line);
	}
	if (kept.length === lines.length) return raw;
	return Buffer.from(kept.join("") + text.slice(end), "latin1");
}

/** IPv4 ranges a client on the public internet never connects from: private, loopback, link-local, CGNAT. */
const PRIVATE_IPV4: [number, number][] = [
	[0x0a000000, 8], // 10.0.0.0/8
	[0x7f000000, 8], // 127.0.0.0/8
	[0x64400000, 10], // 100.64.0.0/10 CGNAT
	[0xa9fe0000, 16], // 169.254.0.0/16 link-local
	[0xac100000, 12], // 172.16.0.0/12
	[0xc0a80000, 16], // 192.168.0.0/16
];

function ipv4Number(value: string): number | null {
	const parts = value.split(".");
	if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
	return parts.reduce((total, part) => total * 256 + Number(part), 0);
}

function isPrivateIpv4(value: number): boolean {
	return PRIVATE_IPV4.some(
		([base, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)),
	);
}

/** The eight 16-bit groups of an IPv6 address (an embedded dotted IPv4 tail included), or null. */
function ipv6Groups(value: string): number[] | null {
	let address = value.toLowerCase();
	const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
	if (tail) {
		const ipv4 = ipv4Number(tail[1]);
		if (ipv4 === null) return null;
		address = `${address.slice(0, tail.index)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
	}
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
	if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
	return groups.map((group) => parseInt(group, 16));
}

/**
 * Whether an SMTP client address is one no sender on the internet has, so SPF cannot be checked against it: IPv4
 * private (RFC 1918), loopback, link-local and CGNAT (100.64.0.0/10), IPv6 loopback, link-local (fe80::/10) and
 * unique local (fc00::/7), and IPv4 addresses mapped into IPv6. Narrower than the SSRF guard on purpose: 6to4,
 * Teredo or documentation ranges can be real senders here.
 */
export function isPrivateClientAddress(address: string): boolean {
	const value = address
		.trim()
		.replace(/^\[|\]$/g, "")
		.replace(/%.*$/, "");
	const ipv4 = ipv4Number(value);
	if (ipv4 !== null) return isPrivateIpv4(ipv4);
	const groups = ipv6Groups(value);
	if (!groups) return false;
	const [a, b, c, d, e, f, g, h] = groups;
	if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return isPrivateIpv4(g * 65536 + h);
	if (groups.slice(0, 7).every((group) => group === 0) && h === 1) return true; // ::1
	if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10
	return (a & 0xfe00) === 0xfc00; // fc00::/7
}
