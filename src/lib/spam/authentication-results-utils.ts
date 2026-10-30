/**
 * Which `Authentication-Results` header (RFC 8601) Kite may believe. Only a hop that verified the
 * message itself writes one we trust, and that is the topmost copy carrying its authserv-id: any
 * copy further down, or any copy at all on a path no verifying hop saw, came from the sender.
 */

/** Cloudflare Email Routing's authserv-id, `mx.cloudflare.net`. */
const CLOUDFLARE_AUTHSERV_ID = /(^|\.)cloudflare\.(com|net)$/;

/** One `method=result` of the header with its `ptype.property=value` pairs, lower-cased keys. */
export type AuthenticationResult = { method: string; result: string; properties: Record<string, string> };

export type ParsedAuthenticationResults = { authservId: string; results: AuthenticationResult[] };

/** The text without `(comments)`, nesting included; quoted strings are kept as they are. */
function stripComments(value: string): string {
	let depth = 0;
	let quoted = false;
	let out = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char === "\\" && (quoted || depth > 0)) {
			if (depth === 0) out += value.slice(index, index + 2);
			index += 1;
		} else if (quoted) {
			out += char;
			if (char === '"') quoted = false;
		} else if (char === "(") depth += 1;
		else if (char === ")" && depth > 0) depth -= 1;
		else if (depth === 0) {
			if (char === '"') quoted = true;
			out += char;
		}
	}
	return out;
}

/** The authserv-id and every result of one header value. */
export function parseAuthenticationResults(value: string): ParsedAuthenticationResults {
	const [head = "", ...segments] = stripComments(value).split(";");
	const results: AuthenticationResult[] = [];
	for (const segment of segments) {
		const [first, ...rest] = segment.trim().split(/\s+/);
		const match = first?.match(/^([a-z0-9_-]+)(?:\/\d+)?=([a-z]+)$/i);
		if (!match) continue;
		const properties: Record<string, string> = {};
		for (const token of rest) {
			const property = token.match(/^([a-z0-9_-]+\.[a-z0-9_-]+)=(.+)$/i);
			if (property) properties[property[1].toLowerCase()] ??= property[2].replace(/^"(.*)"$/, "$1");
		}
		results.push({ method: match[1].toLowerCase(), result: match[2].toLowerCase(), properties });
	}
	return { authservId: head.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "", results };
}

const whitespace = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * The first instance in a joined value when the exact fields are not known: everything before the
 * first comma. The sender chooses how its copy starts and can put text into the trusted copy
 * (addresses), so no parse of where the next copy begins is safe. When that drops text, the trusted
 * copy may have lost a `fail` after the comma, so its passes are downgraded to `none`: a cut can
 * make a sender unverified, never verified.
 */
function cutAtFirstComma(value: string): string {
	const [kept = ""] = value.split(",", 1);
	if (kept.length === value.length) return kept.trim();
	const parsed = parseAuthenticationResults(kept);
	const results = parsed.results.map((entry) =>
		[
			`${entry.method}=${entry.result === "pass" ? "none" : entry.result}`,
			...Object.entries(entry.properties).map(([name, value]) => `${name}=${value}`),
		].join(" "),
	);
	return [parsed.authservId, ...results].join("; ");
}

/**
 * The topmost instance of the field. `Headers.get` and `Object.fromEntries(headers)` join repeated
 * fields with `, ` in message order. `rawFields` are the same field's values from the raw header
 * block, where field boundaries are exact (null when that block could not be read whole).
 *
 * - The map is exactly the raw fields joined: the hop's header is in the raw message, and the first
 *   raw field is it, commas and all.
 * - The map is something more, then exactly the raw fields: the hop added its header to the map
 *   only, and it is that leading part.
 * - The raw message has none (and does not even mention the field, see `completeRawHeaderValues`):
 *   the whole map is the hop's, commas and all.
 *
 * A leading part found only by difference is accepted without a comma, so a field the raw parse
 * and the runtime see differently cannot slip into it. Anything else falls back to `cutAtFirstComma`.
 * This assumes the hop always adds its own header: had it added none, the topmost copy would be the
 * sender's, which is why only a copy naming the hop's authserv-id counts at all.
 */
function topmostAuthenticationResults(joined: string, rawFields: readonly string[] | null): string {
	const value = whitespace(joined);
	if (rawFields) {
		const raw = rawFields.map(whitespace);
		const all = raw.join(", ");
		if (raw.length === 0) return value;
		if (value === all) return raw[0] ?? "";
		const leading = value.endsWith(`, ${all}`) ? value.slice(0, -all.length - 2) : null;
		if (leading !== null && !leading.includes(",")) return leading.trim();
	}
	return cutAtFirstComma(value);
}

/**
 * The header Cloudflare Email Routing added, or null when the topmost copy is not Cloudflare's.
 * Only for mail that came through Email Routing (the Worker `email` handler and the relay Worker).
 */
export function trustedCloudflareAuthenticationResults(
	value: string | null | undefined,
	rawFields: readonly string[] | null,
): string | null {
	if (!value) return null;
	const topmost = topmostAuthenticationResults(value, rawFields);
	return CLOUDFLARE_AUTHSERV_ID.test(parseAuthenticationResults(topmost).authservId) ? topmost : null;
}

/** The authserv-id Kite writes for the verdicts in an SES receipt notification. */
const SES_AUTHSERV_ID = "amazonses.com";

const SES_VERDICTS: Record<string, string> = {
	PASS: "pass",
	FAIL: "fail",
	GRAY: "none",
	PROCESSING_FAILED: "temperror",
};

/**
 * An `Authentication-Results` value for the verdicts SES computed when it received the message
 * (`receipt.spfVerdict`, `dkimVerdict`, `dmarcVerdict`), or null without any. SES names no DKIM
 * signing domain, so a DKIM pass alone never counts as aligned.
 */
export function sesAuthenticationResults(
	verdicts: { spf?: string; dkim?: string; dmarc?: string },
	envelopeFrom: string,
): string | null {
	const results: string[] = [];
	const spf = SES_VERDICTS[verdicts.spf ?? ""];
	// Only a plain address goes into the value Kite parses again.
	const mailfrom = /^[^\s;()",\\]+@[a-z0-9.-]+$/i.test(envelopeFrom) ? ` smtp.mailfrom=${envelopeFrom}` : "";
	if (spf) results.push(`spf=${spf}${mailfrom}`);
	const dkim = SES_VERDICTS[verdicts.dkim ?? ""];
	if (dkim) results.push(`dkim=${dkim}`);
	const dmarc = SES_VERDICTS[verdicts.dmarc ?? ""];
	if (dmarc) results.push(`dmarc=${dmarc}`);
	return results.length ? [SES_AUTHSERV_ID, ...results].join("; ") : null;
}

/** The host a `Received` field says accepted the message (`… by mx.google.com with …`), lower-case, or null. */
function receivedBy(value: string): string | null {
	const host = /\bby\s+([^\s;()]+)/i.exec(stripComments(value))?.[1];
	return host ? host.toLowerCase().replace(/\.$/, "") : null;
}

/**
 * The provider's verdict on mail a connected account synced (spec §6.6), or null. The provider's server is the hop
 * that verified the sender, so only the topmost header of the raw message counts (`fields`, every header field in
 * message order, null when the header block could not be read whole), and only when its authserv-id is exactly the
 * one the account's preset names (such providers remove copies carrying their own authserv-id from incoming mail,
 * RFC 8601 §5) and a `Received` field above it records that same host accepting the message (`… by mx.google.com`),
 * as the provider writes at delivery. A message placed in the Inbox some other way (an IMAP APPEND, a migration
 * tool) normally has neither in that order. A preset without an authserv-id never gets results.
 */
export function externalAuthenticationResults(
	fields: readonly { name: string; value: string }[] | null,
	authservId: string | null,
): string | null {
	if (!authservId || !fields) return null;
	const index = fields.findIndex((field) => field.name === "authentication-results");
	if (index < 0) return null;
	const topmost = whitespace(fields[index].value);
	if (parseAuthenticationResults(topmost).authservId !== authservId.toLowerCase()) return null;
	const host = authservId.toLowerCase();
	const received = fields
		.slice(0, index)
		.some((field) => field.name === "received" && receivedBy(field.value) === host);
	return received ? topmost : null;
}
