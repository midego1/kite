/**
 * The relay Worker's request signatures. Portable (no imports) so the relay Worker in
 * deploy/cloudflare-email-relay signs with the same code the server verifies with
 * (`src/lib/email/intake-signature.ts`).
 */

const encoder = new TextEncoder();

/** The label that derives the headers signature key from `INBOUND_WEBHOOK_SECRET`. */
const HEADERS_KEY_LABEL = "kite-relay-headers-signature-key-v1";

/**
 * HMAC-SHA256 over `data`, raw bytes.
 * @param {Uint8Array} key
 * @param {Uint8Array} data
 * @returns {Promise<ArrayBuffer>}
 */
async function hmacBytes(key, data) {
	const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", imported, data);
}

/**
 * HMAC-SHA256 over `prefix` + raw body, hex encoded.
 * @param {Uint8Array} key
 * @param {string} prefixText
 * @param {ArrayBuffer} raw
 * @returns {Promise<string>}
 */
async function hmac(key, prefixText, raw) {
	const prefix = encoder.encode(prefixText);
	const data = new Uint8Array(prefix.byteLength + raw.byteLength);
	data.set(prefix, 0);
	data.set(new Uint8Array(raw), prefix.byteLength);
	return Array.from(new Uint8Array(await hmacBytes(key, data)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string} headersJson
 */
const headersPrefix = (from, to, headersJson) => `kite-headers\n${from}\n${to}\n${headersJson}\n`;

/**
 * `X-Kite-Signature`: HMAC-SHA256 with the secret over `from\nto\n` + raw body, hex encoded.
 * @param {string} secret
 * @param {ArrayBuffer} raw
 * @param {string} from
 * @param {string} to
 */
export function signInbound(secret, raw, from, to) {
	return hmac(encoder.encode(secret), `${from}\n${to}\n`, raw);
}

/**
 * `X-Kite-Headers-Signature`: HMAC-SHA256 over `kite-headers\nfrom\nto\n<X-Kite-Headers JSON>\n` +
 * raw body, hex encoded, with a key of its own: HMAC-SHA256 of `HEADERS_KEY_LABEL` under the secret.
 * It binds the header map, which carries Cloudflare's Authentication-Results, to the envelope and
 * the body it came with.
 * @param {string} secret
 * @param {ArrayBuffer} raw
 * @param {string} from
 * @param {string} to
 * @param {string} headersJson
 */
export async function signInboundHeaders(secret, raw, from, to, headersJson) {
	const key = new Uint8Array(await hmacBytes(encoder.encode(secret), encoder.encode(HEADERS_KEY_LABEL)));
	return hmac(key, headersPrefix(from, to, headersJson), raw);
}

/**
 * The headers signature as the first relay releases with one made it, with the secret itself as the
 * key. The server still accepts it for a while (docs/self-hosting.md); the relay no longer sends it.
 * TODO(#118): remove in the first release on or after 2027-01-31.
 * @param {string} secret
 * @param {ArrayBuffer} raw
 * @param {string} from
 * @param {string} to
 * @param {string} headersJson
 */
export function signInboundHeadersWithSecret(secret, raw, from, to, headersJson) {
	return hmac(encoder.encode(secret), headersPrefix(from, to, headersJson), raw);
}
