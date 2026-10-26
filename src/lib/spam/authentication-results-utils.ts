/**
 * Which `Authentication-Results` header (RFC 8601) Kite may believe. Only a hop that verified the
 * message itself writes one we trust, and that is the topmost copy carrying its authserv-id: any
 * copy further down, or any copy at all on a path no verifying hop saw, came from the sender.
 */

/** Cloudflare Email Routing's authserv-id, `mx.cloudflare.net`. */
const CLOUDFLARE_AUTHSERV_ID = /(^|\.)cloudflare\.(com|net)$/;

/** The authserv-id of one header value, lower-cased, without its optional version. */
function authservIdOf(value: string): string {
	return value.split(";", 1)[0]?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

/**
 * The first instance of the field: everything before the first comma. `Headers.get` and
 * `Object.fromEntries(headers)` join repeated fields with `, ` in message order, so a sender's copy
 * would otherwise follow the trusted one. Cutting at any comma, even one in a comment, is
 * deliberate: the sender chooses how its copy starts (comments, a quoted authserv-id) and can put
 * text into the trusted copy (addresses), so no parse of where the next copy begins is safe. A
 * trusted copy with a comma only loses its tail, never gains a sender's results.
 */
export function topmostAuthenticationResults(value: string): string {
	return (value.split(",", 1)[0] ?? "").trim();
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
