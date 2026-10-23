import type { SpamSignal } from "../types";
import type { LookupKind, LookupRequest } from "./abuse-ch-types";

const API = "https://urlhaus-api.abuse.ch/v1";

/** URLhaus answers `query_status: "ok"` only for a URL or file it lists; anything else is not a match. */
function isListed(answer: unknown): boolean {
	return !!answer && typeof answer === "object" && (answer as { query_status?: unknown }).query_status === "ok";
}

/** A URLhaus lookup of a link exactly as it appears, or of an attachment's SHA-256 hash. */
export function urlhausRequest(kind: LookupKind, value: string): LookupRequest {
	const [endpoint, field] = kind === "link" ? ["url", "url"] : ["payload", "sha256_hash"];
	return {
		service: "urlhaus",
		kind,
		url: `${API}/${endpoint}/`,
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams({ [field]: value }).toString(),
		listed: isListed,
	};
}

export function urlhausSignals(listedUrls: number, listedPayloads: number): SpamSignal[] {
	const signals: SpamSignal[] = [];
	if (listedUrls > 0)
		signals.push({
			id: "urlhaus_url",
			score: 40,
			reason: "A link is on URLhaus's list of malware sites",
			metadata: { count: listedUrls },
		});
	if (listedPayloads > 0)
		signals.push({
			id: "urlhaus_payload",
			score: 50,
			reason: "An attachment matches malware known to URLhaus",
			metadata: { count: listedPayloads },
		});
	return signals;
}
