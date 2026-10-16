import type { SpamIntelligenceInput, SpamIntelligenceProvider, SpamSignal } from "../types";
import { LocalSpamIntelligenceProvider } from "./local";
import { isListed, LOOKUP_TIMEOUT_MS, planUrlhausLookups, urlhausSignals } from "./urlhaus-utils";

const API = "https://urlhaus-api.abuse.ch/v1";

async function sha256Hex(content: ArrayBuffer): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Checks links and attachment hashes against abuse.ch URLhaus. A lookup that fails or times out
 * counts as not listed, so an outage never holds mail back or marks it.
 */
export class UrlhausIntelligenceProvider implements SpamIntelligenceProvider {
	constructor(
		private readonly authKey: string,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	private async listed(endpoint: "url" | "payload", field: string, value: string): Promise<boolean> {
		try {
			const response = await this.fetcher(`${API}/${endpoint}/`, {
				method: "POST",
				headers: { "Auth-Key": this.authKey, "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ [field]: value }).toString(),
				signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
			});
			if (!response.ok) return false;
			return isListed(await response.json());
		} catch {
			return false;
		}
	}

	async check(input: SpamIntelligenceInput): Promise<SpamSignal[]> {
		const { urls, payloads } = planUrlhausLookups(input);
		if (urls.length === 0 && payloads.length === 0) return [];
		const [urlResults, payloadResults] = await Promise.all([
			Promise.all(urls.map((url) => this.listed("url", "url", url))),
			Promise.all(
				payloads.map(async (attachment) => this.listed("payload", "sha256_hash", await sha256Hex(attachment.content))),
			),
		]);
		return urlhausSignals(urlResults.filter(Boolean).length, payloadResults.filter(Boolean).length);
	}
}

/** URLhaus when the operator set `URLHAUS_AUTH_KEY`; otherwise no outside lookups at all. */
export function spamIntelligenceProvider(env: CloudflareEnv): SpamIntelligenceProvider {
	const key = env.URLHAUS_AUTH_KEY?.trim();
	return key ? new UrlhausIntelligenceProvider(key) : new LocalSpamIntelligenceProvider();
}

export function isUrlhausConfigured(env: CloudflareEnv): boolean {
	return !!env.URLHAUS_AUTH_KEY?.trim();
}
