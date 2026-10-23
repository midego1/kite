import type { SpamIntelligenceInput, SpamSignal } from "../types";
import type {
	AbuseChSecretName,
	AbuseChService,
	KeySaveDecision,
	KeyTestResult,
	KeyTestResults,
	LookupOutcome,
	LookupResult,
	ResolvedAbuseChKey,
	ThreatLookupPlan,
} from "./abuse-ch-types";
import { threatfoxSignals } from "./threatfox-utils";
import { urlhausSignals } from "./urlhaus-utils";

const MAX_URL_LOOKUPS = 5;
const MAX_PAYLOAD_LOOKUPS = 3;
/** Each lookup gives up after this long; mail is delivered without the answer. */
export const LOOKUP_TIMEOUT_MS = 3000;

/** Kite's own findings that make a message worth showing its links to abuse.ch. */
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
/** What a second list adds when URLhaus already lists every input matched by ThreatFox. */
const SECOND_LIST_SCORE = 10;
// abuse.ch names a refused key in `query_status`, as in `unknown_auth_key` or `illegal_auth_key`.
const KEY_STATUS = /auth[_-]?key/i;

function showsRisk(signals: readonly SpamSignal[]): boolean {
	if (signals.some((signal) => signal.score > 0 && RISK_SIGNALS.has(signal.id))) return true;
	return signals.reduce((total, signal) => total + Math.max(0, signal.score), 0) >= RISK_SCORE;
}

/**
 * What to ask abuse.ch about: nothing unless the message already shows a risk (an attached web page or
 * program always does). Links, which may carry personal tokens, go first from inside attachments.
 * Attachments are sent as SHA-256 hashes only; inline images are left out.
 */
export function planThreatLookups(input: SpamIntelligenceInput): ThreatLookupPlan {
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

/** The abuse.ch Auth-Key secret: `URLHAUS_AUTH_KEY`, or `ABUSE_CH_AUTH_KEY` when that is unset. */
export function abuseChAuthKey(env: Pick<CloudflareEnv, "URLHAUS_AUTH_KEY" | "ABUSE_CH_AUTH_KEY">): string | null {
	return env.URLHAUS_AUTH_KEY?.trim() || env.ABUSE_CH_AUTH_KEY?.trim() || null;
}

/** The name of the secret `abuseChAuthKey` reads, or null when neither is set. */
export function abuseChSecretName(
	env: Pick<CloudflareEnv, "URLHAUS_AUTH_KEY" | "ABUSE_CH_AUTH_KEY">,
): AbuseChSecretName | null {
	if (env.URLHAUS_AUTH_KEY?.trim()) return "URLHAUS_AUTH_KEY";
	return env.ABUSE_CH_AUTH_KEY?.trim() ? "ABUSE_CH_AUTH_KEY" : null;
}

/** A secret always wins over a key saved in Kite, so an operator can pin the key outside the database. */
export function pickAbuseChKey(secret: string | null, saved: string | null | undefined): ResolvedAbuseChKey | null {
	if (secret) return { key: secret, source: "secret" };
	const trimmed = saved?.trim();
	return trimmed ? { key: trimmed, source: "settings" } : null;
}

// The key travels in an HTTP header, so only visible ASCII without spaces is accepted.
const AUTH_KEY_PATTERN = /^[!-~]{1,200}$/;

/** The key the owner typed, trimmed, or null when it cannot be an Auth-Key. */
export function parseAbuseChKeyInput(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return AUTH_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

/** Either list refusing the key blocks saving it; an unreachable list saves it unchecked. */
export function keySaveDecision(results: KeyTestResults): KeySaveDecision {
	const outcomes = Object.values(results);
	if (outcomes.includes("rejected")) return "rejected";
	return outcomes.includes("unreachable") ? "unverified" : "verified";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Dev/test only: the loopback origin that stands in for abuse.ch, or null (always null in production). */
export function abuseChTestOrigin(value: string | undefined, nodeEnv: string | undefined): string | null {
	if (!value?.trim() || nodeEnv === "production") return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null;
	} catch {
		return null;
	}
}

/** The same path and query on the test origin; both abuse.ch APIs are told apart by path. */
export function abuseChTestUrl(url: string, origin: string): string {
	const parsed = new URL(url);
	return `${origin}${parsed.pathname}${parsed.search}`;
}

/** Reads one answer: a refused key (401, 403 or a key status), any other failure, or whether it lists the item. */
export function lookupOutcome(status: number, answer: unknown, listed: (answer: unknown) => boolean): LookupOutcome {
	if (status === 401 || status === 403) return "key_rejected";
	const queryStatus = answer && typeof answer === "object" ? (answer as { query_status?: unknown }).query_status : null;
	if (typeof queryStatus === "string" && KEY_STATUS.test(queryStatus)) return "key_rejected";
	if (status < 200 || status >= 300) return "failed";
	return listed(answer) ? "listed" : "not_listed";
}

/** Each service that refused the key at least once, in the order first seen. */
export function rejectedServices(results: readonly LookupResult[]): AbuseChService[] {
	return [...new Set(results.filter((result) => result.outcome === "key_rejected").map((result) => result.service))];
}

/**
 * The signals of both lists. Discount ThreatFox only when all of its matched URLs or hashes are
 * already listed on URLhaus; a distinct bad link or file must retain the full signal.
 */
export function lookupSignals(results: readonly LookupResult[]): SpamSignal[] {
	const listed = (service: AbuseChService, kind: LookupResult["kind"]) =>
		results.filter((result) => result.service === service && result.kind === kind && result.outcome === "listed");
	const alreadyListed = (kind: LookupResult["kind"]) => {
		const inputs = new Set(listed("urlhaus", kind).flatMap((result) => result.inputs));
		return listed("threatfox", kind).every(
			(result) => result.inputs.length > 0 && result.inputs.every((input) => inputs.has(input)),
		);
	};
	const urlhaus = urlhausSignals(listed("urlhaus", "link").length, listed("urlhaus", "payload").length);
	const threatfox = threatfoxSignals(listed("threatfox", "link").length, listed("threatfox", "payload").length).map(
		(signal) =>
			alreadyListed(signal.id === "threatfox_url" ? "link" : "payload")
				? { ...signal, score: SECOND_LIST_SCORE, metadata: { ...signal.metadata, alsoOnUrlhaus: true } }
				: signal,
	);
	return [...urlhaus, ...threatfox];
}

/** A key test passes when the service answered at all, listed or not. */
export function keyTestResult(outcome: LookupOutcome): KeyTestResult {
	if (outcome === "key_rejected") return "rejected";
	return outcome === "failed" ? "unreachable" : "works";
}
