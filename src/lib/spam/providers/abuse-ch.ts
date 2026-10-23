import { createLogger } from "@/lib/logger.mjs";
import type { SpamIntelligenceInput, SpamIntelligenceProvider, SpamSignal } from "../types";
import type { KeyTestResults, LookupOutcome, LookupRequest, LookupResult } from "./abuse-ch-types";
import {
	abuseChAuthKey,
	abuseChTestOrigin,
	abuseChTestUrl,
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
	private authKey: Promise<string | null> | null = null;

	constructor(
		private readonly loadKey: () => Promise<string | null>,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	async check(input: SpamIntelligenceInput): Promise<SpamSignal[]> {
		const { urls, payloads } = planThreatLookups(input);
		if (urls.length === 0 && payloads.length === 0) return [];
		// Read the key only for mail that would be looked up, and once per provider.
		this.authKey ??= this.loadKey();
		const authKey = await this.authKey;
		if (!authKey) return [];
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
				outcome: await lookup(this.fetcher, authKey, request),
			})),
		);
		logRejectedKey(results, "mail");
		return lookupSignals(results);
	}
}

/**
 * abuse.ch lookups with the secret Auth-Key, or else the one `savedKey` finds (the key saved in Kite);
 * without either, no outside lookups at all.
 */
export function spamIntelligenceProvider(
	env: Pick<CloudflareEnv, "URLHAUS_AUTH_KEY" | "ABUSE_CH_AUTH_KEY">,
	fetcher: typeof fetch = fetch,
	savedKey?: () => Promise<string | null>,
): SpamIntelligenceProvider {
	const secret = abuseChAuthKey(env);
	if (secret) return new AbuseChIntelligenceProvider(async () => secret, fetcher);
	return savedKey ? new AbuseChIntelligenceProvider(savedKey, fetcher) : new LocalSpamIntelligenceProvider();
}

/** `fetch`, sent to the loopback stand-in for abuse.ch when `ABUSE_CH_TEST_ORIGIN` allows it (never in production). */
export function abuseChFetcher(
	env: Pick<CloudflareEnv, "ABUSE_CH_TEST_ORIGIN">,
	fetcher: typeof fetch = fetch,
): typeof fetch {
	const origin = abuseChTestOrigin(env.ABUSE_CH_TEST_ORIGIN, process.env.NODE_ENV);
	if (!origin) return fetcher;
	return ((input: RequestInfo | URL, init?: RequestInit) =>
		fetcher(abuseChTestUrl(String(input instanceof Request ? input.url : input), origin), init)) as typeof fetch;
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
