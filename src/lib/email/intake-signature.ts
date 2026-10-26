import { signInbound, signInboundHeaders } from "@/lib/email/inbound-signature.mjs";

function safeEqualHex(expected: string, signature: string): boolean {
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let index = 0; index < expected.length; index += 1)
		diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
	return diff === 0;
}

/**
 * Reads one of the relay's `X-Kite-*` request headers. Relays deployed before
 * the rename to Kite send `X-Mailflare-*` instead, so the server keeps
 * accepting both and can be updated before the relay.
 */
export function readRelayHeader(
	headers: Headers,
	name: "from" | "to" | "signature" | "headers" | "headers-signature",
): string | null {
	return headers.get(`x-kite-${name}`) ?? headers.get(`x-mailflare-${name}`);
}

/** Checks `X-Kite-Signature` (`signInbound` in `inbound-signature.mjs`, shared with the relay Worker). */
export async function verifyInboundSignature(
	secret: string,
	signature: string,
	raw: ArrayBuffer,
	from: string,
	to: string,
): Promise<boolean> {
	return safeEqualHex(await signInbound(secret, raw, from, to), signature);
}

/**
 * Checks `X-Kite-Headers-Signature` (`signInboundHeaders`), which the relay Worker sends since the
 * header map started to carry trust (Cloudflare's `Authentication-Results`).
 */
export async function verifyInboundHeadersSignature(
	secret: string,
	signature: string,
	raw: ArrayBuffer,
	from: string,
	to: string,
	headersJson: string,
): Promise<boolean> {
	return safeEqualHex(await signInboundHeaders(secret, raw, from, to, headersJson), signature);
}
