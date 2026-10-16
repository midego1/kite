import type { AttachmentContent } from "@/lib/email/attachment-types";
import type { SpamIntelligenceInput, SpamSignal } from "../types";

const MAX_URL_LOOKUPS = 5;
const MAX_PAYLOAD_LOOKUPS = 3;
/** Each lookup gives up after this long; mail is delivered without the answer. */
export const LOOKUP_TIMEOUT_MS = 3000;

/** Kite's own findings that make a message worth showing its links to URLhaus. */
const RISK_SIGNALS = new Set([
	"displayed_link_mismatch",
	"ip_address_url",
	"punycode_url",
	"html_attachment",
	"attachment_login_form",
	"attachment_active_content",
	"risky_attachment",
	"credential_phishing_pattern",
	"payment_scam_pattern",
	"safelist_pressure",
	"dmarc_failed",
	"spf_failed",
	"dkim_failed",
]);
/** Together, weaker findings count as a risk too. */
const RISK_SCORE = 15;

export type UrlhausLookups = { urls: string[]; payloads: AttachmentContent[] };

function showsRisk(signals: readonly SpamSignal[]): boolean {
	if (signals.some((signal) => signal.score > 0 && RISK_SIGNALS.has(signal.id))) return true;
	return signals.reduce((total, signal) => total + Math.max(0, signal.score), 0) >= RISK_SCORE;
}

/**
 * What to ask URLhaus about: nothing unless the message already shows a risk (an attached web page or
 * program always does). Links, which may carry personal tokens, go first from inside attachments.
 * Attachments are sent as SHA-256 hashes only; inline images are left out.
 */
export function planUrlhausLookups(input: SpamIntelligenceInput): UrlhausLookups {
	if (!showsRisk(input.localSignals)) return { urls: [], payloads: [] };
	const urls = [...new Set([...input.attachmentUrls, ...input.urls])]
		.filter((url) => /^https?:\/\//i.test(url))
		.slice(0, MAX_URL_LOOKUPS);
	const payloads = input.attachments
		.filter((attachment) => !(attachment.contentId && attachment.type.toLowerCase().startsWith("image/")))
		.filter((attachment) => attachment.content && attachment.content.byteLength > 0)
		.slice(0, MAX_PAYLOAD_LOOKUPS);
	return { urls, payloads };
}

/** URLhaus answers `query_status: "ok"` only for a URL or file it lists; anything else is not a match. */
export function isListed(answer: unknown): boolean {
	return !!answer && typeof answer === "object" && (answer as { query_status?: unknown }).query_status === "ok";
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
