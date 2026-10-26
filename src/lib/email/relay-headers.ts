import { readRelayHeader, verifyInboundHeadersSignature } from "@/lib/email/intake-signature";
import { completeRawHeaderValues } from "@/lib/email/raw-headers";
import { createLogger } from "@/lib/logger.mjs";
import { trustedCloudflareAuthenticationResults } from "@/lib/spam/authentication-results-utils";

const logger = createLogger("inbound");

/** `missing`: a relay from before the headers signature; `legacy`: one keyed with the secret itself. */
export type RelayHeadersSignature = "valid" | "legacy" | "missing" | "invalid";

const LOG_INTERVAL_MS = 10 * 60_000;
const loggedAt = new Map<RelayHeadersSignature, number>();

/** At most one line per kind and isolate every ten minutes: every message of an old relay has it. */
function logSignature(status: RelayHeadersSignature): void {
	if (status === "valid") return;
	const now = Date.now();
	if (now - (loggedAt.get(status) ?? -Infinity) < LOG_INTERVAL_MS) return;
	loggedAt.set(status, now);
	if (status === "invalid") {
		logger.error("relay.headers_signature_invalid", {
			effect: "authentication_unknown",
			hint: "Update the relay (redeploy deploy/cloudflare-email-relay) and make sure its INBOUND_WEBHOOK_SECRET matches the server's",
		});
		return;
	}
	logger.warn(status === "missing" ? "relay.headers_signature_missing" : "relay.headers_signature_legacy", {
		effect: status === "missing" ? "authentication_unknown" : "accepted",
		...(status === "legacy" ? { acceptedUntil: "2027-01-31", issue: 118 } : {}),
		hint: "Update the relay: redeploy deploy/cloudflare-email-relay so it signs the header map with the current key",
	});
}

/**
 * The header map the relay Worker read from Cloudflare Email Routing (`X-Kite-Headers`), and the
 * `Authentication-Results` Cloudflare added. That one counts only when `X-Kite-Headers-Signature`
 * proves the map came from the relay with this body: the map is not covered by `X-Kite-Signature`,
 * and relays deployed before the headers signature leave the sender's authentication unknown. The
 * caller has already checked `X-Kite-Signature`, so the raw body's own fields are exact and help find
 * Cloudflare's copy (`topmostAuthenticationResults`).
 */
export async function readRelayHeaders(
	secret: string,
	requestHeaders: Headers,
	raw: ArrayBuffer,
	from: string,
	to: string,
): Promise<{
	headers: Record<string, string>;
	authenticationResults: string | null;
	signature: RelayHeadersSignature;
}> {
	const json = readRelayHeader(requestHeaders, "headers") ?? "{}";
	let headers: Record<string, string> = {};
	try {
		const parsed: unknown = JSON.parse(json);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) headers = parsed as Record<string, string>;
	} catch {
		// The header map is advisory; the raw message is authoritative.
	}
	const header = readRelayHeader(requestHeaders, "headers-signature");
	const signature = header ? await verifyInboundHeadersSignature(secret, header, raw, from, to, json) : "missing";
	logSignature(signature);
	const value = signature === "valid" || signature === "legacy" ? headers["authentication-results"] : null;
	return {
		headers,
		authenticationResults:
			typeof value === "string"
				? trustedCloudflareAuthenticationResults(value, completeRawHeaderValues(raw, "authentication-results"))
				: null,
		signature,
	};
}
