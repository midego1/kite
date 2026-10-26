import { readRelayHeader, verifyInboundHeadersSignature } from "@/lib/email/intake-signature";
import { trustedCloudflareAuthenticationResults } from "@/lib/spam/authentication-results-utils";

/**
 * The header map the relay Worker read from Cloudflare Email Routing (`X-Kite-Headers`), and the
 * `Authentication-Results` Cloudflare added. That one counts only when `X-Kite-Headers-Signature`
 * proves the map came from the relay with this body: the map is not covered by `X-Kite-Signature`,
 * and relays deployed before the headers signature leave the sender's authentication unknown.
 */
export async function readRelayHeaders(
	secret: string,
	requestHeaders: Headers,
	raw: ArrayBuffer,
	from: string,
	to: string,
): Promise<{ headers: Record<string, string>; authenticationResults: string | null }> {
	const json = readRelayHeader(requestHeaders, "headers") ?? "{}";
	let headers: Record<string, string> = {};
	try {
		const parsed: unknown = JSON.parse(json);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) headers = parsed as Record<string, string>;
	} catch {
		// The header map is advisory; the raw message is authoritative.
	}
	const signature = readRelayHeader(requestHeaders, "headers-signature");
	const signed = !!signature && (await verifyInboundHeadersSignature(secret, signature, raw, from, to, json));
	const value = signed ? headers["authentication-results"] : null;
	return {
		headers,
		authenticationResults: typeof value === "string" ? trustedCloudflareAuthenticationResults(value) : null,
	};
}
