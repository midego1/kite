/**
 * Which `Authentication-Results` header (RFC 8601) Kite may believe. Only a hop that verified the
 * message itself writes one we trust, and that is the topmost copy carrying its authserv-id: any
 * copy further down, or any copy at all on a path no verifying hop saw, came from the sender.
 */

/** Cloudflare Email Routing's authserv-id, `mx.cloudflare.net`. */
const CLOUDFLARE_AUTHSERV_ID = /(^|\.)cloudflare\.(com|net)$/;

/**
 * A comment (CFWS) in the field, one nesting level deep. An authserv-id may carry comments around
 * it (`mail.example.test (comment);`), so a boundary check that assumes a bare server name misses
 * a sender's copy and keeps its forged results inside the trusted string.
 */
const COMMENT = String.raw`\((?:[^()]|\([^()]*\))*\)`;

/**
 * Where `Headers` joined the next instance of the field on: `, ` followed by another authserv-id
 * (optionally with comments and a version) and its `;`. A `,` inside one header's comments is
 * followed by `name=value` or `)`, never by `token;`.
 */
const NEXT_INSTANCE = new RegExp(`,\\s*(?=(?:${COMMENT}\\s*)*[^\\s;,()="]+(?:\\s+\\d+)?(?:\\s*${COMMENT})*\\s*;)`);

/** The authserv-id of one header value, lower-cased, without its optional version. */
function authservIdOf(value: string): string {
	return value.split(";", 1)[0]?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

/**
 * The first instance of the field. `Headers.get` and `Object.fromEntries(headers)` join repeated
 * fields with `, ` in message order, so a sender's copy would otherwise follow the trusted one.
 */
export function topmostAuthenticationResults(value: string): string {
	return (value.split(NEXT_INSTANCE, 1)[0] ?? "").trim();
}

/**
 * The header Cloudflare Email Routing added, or null when the topmost copy is not Cloudflare's.
 * Only for mail that came through Email Routing (the Worker `email` handler and the relay Worker).
 */
export function trustedCloudflareAuthenticationResults(value: string | null | undefined): string | null {
	if (!value) return null;
	const topmost = topmostAuthenticationResults(value);
	return CLOUDFLARE_AUTHSERV_ID.test(authservIdOf(topmost)) ? topmost : null;
}
