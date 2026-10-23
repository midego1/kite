import { createLogger } from "@/lib/logger.mjs";
import type { SpamIntelligenceInput, SpamIntelligenceProvider, SpamSignal } from "../types";
import type { KeyTestResults, LookupOutcome, LookupRequest, LookupResult } from "./abuse-ch-types";
import {
	abuseChAuthKey,
	keyTestResult,
	LOOKUP_TIMEOUT_MS,
	lookupOutcome,
	lookupSignals,
	planThreatLookups,
	rejectedServices,
} from "./abuse-ch-utils";
import { LocalSpamIntelligenceProvider } from "./local";
import { threatfoxHashRequest, threatfoxHostTerms, threatfoxIocRequest } from "./threatfox-utils";
import { urlhausRequest } from "./urlhaus-utils";

const logger = createLogger("spam");

async function sha256Hex(content: ArrayBuffer): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function lookup(fetcher: typeof fetch, authKey: string, request: LookupRequest): Promise<LookupOutcome> {
	try {
		const response = await fetcher(request.url, {
			method: "POST",
			headers: { "Auth-Key": authKey, "Content-Type": request.contentType },
			body: request.body,
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
		const answer: unknown = await response.json().catch(() => null);
		return lookupOutcome(response.status, answer, request.listed);
	} catch {
		return "failed";
	}
}

/** Names only the service; the key and what was looked up never reach the log. */
function logRejectedKey(results: readonly LookupResult[], source: "mail" | "key_test") {
	for (const service of rejectedServices(results)) logger.warn("spam.threat_lookup_key_rejected", { service, source });
}

/**
 * Checks links and attachment hashes against abuse.ch URLhaus and ThreatFox, both at once and with the
 * same key. A lookup that fails or times out counts as not listed, so an outage never holds mail back or marks it.
 */
class AbuseChIntelligenceProvider implements SpamIntelligenceProvider {
	constructor(
		private readonly authKey: string,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	async check(input: SpamIntelligenceInput): Promise<SpamSignal[]> {
		const { urls, payloads } = planThreatLookups(input);
		if (urls.length === 0 && payloads.length === 0) return [];
		const hashes = [...new Set(await Promise.all(payloads.map((attachment) => sha256Hex(attachment.content))))];
		const requests = [
			...urls.map((url) => urlhausRequest("link", url)),
			...hashes.map((hash) => urlhausRequest("payload", hash)),
			...threatfoxHostTerms(urls).map((term) => threatfoxIocRequest(term, urls)),
			...hashes.map(threatfoxHashRequest),
		];
		const results = await Promise.all(
			requests.map(async (request) => ({
				service: request.service,
				kind: request.kind,
				inputs: request.inputs,
				outcome: await lookup(this.fetcher, this.authKey, request),
			})),
		);
		logRejectedKey(results, "mail");
		return lookupSignals(results);
	}
}

/** abuse.ch lookups when the operator set an Auth-Key; otherwise no outside lookups at all. */
export function spamIntelligenceProvider(
	env: Pick<CloudflareEnv, "URLHAUS_AUTH_KEY" | "ABUSE_CH_AUTH_KEY">,
	fetcher: typeof fetch = fetch,
): SpamIntelligenceProvider {
	const key = abuseChAuthKey(env);
	return key ? new AbuseChIntelligenceProvider(key, fetcher) : new LocalSpamIntelligenceProvider();
}

/** One harmless lookup per service (`example.com`), so an admin can tell a refused key from an outage. */
export async function testAbuseChKey(authKey: string, fetcher: typeof fetch = fetch): Promise<KeyTestResults> {
	const requests = [
		urlhausRequest("link", "http://example.com/"),
		threatfoxIocRequest("example.com", ["http://example.com/"]),
	];
	const results = await Promise.all(
		requests.map(async (request) => ({
			service: request.service,
			kind: request.kind,
			inputs: request.inputs,
			outcome: await lookup(fetcher, authKey, request),
		})),
	);
	logRejectedKey(results, "key_test");
	const outcome = (service: LookupResult["service"]) =>
		keyTestResult(results.find((result) => result.service === service)?.outcome ?? "failed");
	return { urlhaus: outcome("urlhaus"), threatfox: outcome("threatfox") };
}
