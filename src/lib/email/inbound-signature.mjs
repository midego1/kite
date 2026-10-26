/**
 * The relay Worker's request signatures. Portable (no imports) so the relay Worker in
 * deploy/cloudflare-email-relay signs with the same code the server verifies with
 * (`src/lib/email/intake-signature.ts`).
 */

/**
 * HMAC-SHA256 over `prefix` + raw body, hex encoded.
 * @param {string} secret
 * @param {string} prefixText
 * @param {ArrayBuffer} raw
 * @returns {Promise<string>}
 */
async function hmac(secret, prefixText, raw) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const prefix = new TextEncoder().encode(prefixText);
	const data = new Uint8Array(prefix.byteLength + raw.byteLength);
	data.set(prefix, 0);
	data.set(new Uint8Array(raw), prefix.byteLength);
	return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * `X-Kite-Signature`: HMAC-SHA256 over `from\nto\n` + raw body, hex encoded.
 * @param {string} secret
 * @param {ArrayBuffer} raw
 * @param {string} from
 * @param {string} to
 */
export function signInbound(secret, raw, from, to) {
	return hmac(secret, `${from}\n${to}\n`, raw);
}

/**
 * `X-Kite-Headers-Signature`: HMAC-SHA256 over `kite-headers\nfrom\nto\n<X-Kite-Headers JSON>\n` +
 * raw body, hex encoded. It binds the header map, which carries Cloudflare's
 * Authentication-Results, to the envelope and the body it came with.
 * @param {string} secret
 * @param {ArrayBuffer} raw
 * @param {string} from
 * @param {string} to
 * @param {string} headersJson
 */
export function signInboundHeaders(secret, raw, from, to, headersJson) {
	return hmac(secret, `kite-headers\n${from}\n${to}\n${headersJson}\n`, raw);
}
