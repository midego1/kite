import { registrableDomain } from "./analyzers/link-host-utils";
import { parseAuthenticationResults } from "./authentication-results-utils";
import type { DmarcPolicy } from "./types";

/**
 * How failed sender authentication is enforced (upstream Mailflare #216): a failure the sender's domain asks receivers
 * to act on files the message as spam, whatever else the score says. User-facing behaviour is in
 * docs/spam-protection.md.
 */

const STRICTNESS: Record<DmarcPolicy, number> = { unknown: 0, none: 1, quarantine: 2, reject: 3 };
const PUBLISHED = new Set<string>(["none", "quarantine", "reject"]);

function stricter(a: DmarcPolicy | null, b: DmarcPolicy): DmarcPolicy {
	return a && STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/**
 * The policy the From domain publishes, as the verifying hop reported it in the first `dmarc=` result of a trusted
 * `Authentication-Results` value: `policy.dmarc=` (Cloudflare, Kite's own SMTP listener, SES) or the DMARCbis
 * `policy.published-domain-policy=`, the stricter one if both appear. Comments are not read: what a hop writes there
 * (`p=REJECT sp=NONE`) is the raw record, not the policy that applies to a subdomain sender, so DNS answers instead.
 * Null when the result names no policy.
 */
export function publishedDmarcPolicy(trusted: string | null | undefined): DmarcPolicy | null {
	if (!trusted) return null;
	const dmarc = parseAuthenticationResults(trusted).results.find((entry) => entry.method === "dmarc");
	let found: DmarcPolicy | null = null;
	for (const name of ["policy.dmarc", "policy.published-domain-policy"]) {
		const value = dmarc?.properties[name]?.toLowerCase();
		if (value && PUBLISHED.has(value)) found = stricter(found, value as DmarcPolicy);
	}
	return found;
}

/** One level gentler: what a domain still testing its policy (`t=y`, or `pct` under 100) really asks for. */
function gentler(policy: DmarcPolicy): DmarcPolicy {
	return policy === "reject" ? "quarantine" : policy === "quarantine" ? "none" : policy;
}

/**
 * The policy in a `_dmarc` TXT answer (RFC 7489 §6.3), or null when the answer holds no DMARC record. `inherited`
 * reads the organizational domain's record for a subdomain, where `sp=` applies before `p=`. Several records, or one
 * without a valid policy, give `unknown`, as RFC 7489 §6.6.3 says to ignore them.
 */
export function parseDmarcRecord(answers: readonly string[], inherited = false): DmarcPolicy | null {
	const records = answers.filter((answer) => /^v\s*=\s*DMARC1\s*(;|$)/i.test(answer.trim()));
	if (records.length === 0) return null;
	if (records.length > 1) return "unknown";
	const tags = new Map<string, string>();
	for (const part of records[0].split(";")) {
		const index = part.indexOf("=");
		if (index > 0)
			tags.set(
				part.slice(0, index).trim().toLowerCase(),
				part
					.slice(index + 1)
					.trim()
					.toLowerCase(),
			);
	}
	const value = (inherited ? (tags.get("sp") ?? tags.get("p")) : tags.get("p")) ?? "";
	if (!PUBLISHED.has(value)) return "unknown";
	const pct = tags.has("pct") ? Number(tags.get("pct")) : 100;
	const testing = tags.get("t") === "y" || (Number.isFinite(pct) && pct < 100);
	return testing ? gentler(value as DmarcPolicy) : (value as DmarcPolicy);
}

/** Where a domain's DMARC record may be: its own `_dmarc` name, then its organizational domain's. */
export function dmarcRecordNames(fromDomain: string): { name: string; inherited: boolean }[] {
	const domain = fromDomain.trim().toLowerCase().replace(/\.$/, "");
	if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(domain)) return [];
	const organizational = registrableDomain(domain);
	return [
		{ name: `_dmarc.${domain}`, inherited: false },
		...(organizational && organizational !== domain ? [{ name: `_dmarc.${organizational}`, inherited: true }] : []),
	];
}

/**
 * Whether the From address may be forged, so a known sender's trust must not count: DMARC failed, or a check failed
 * without a DMARC pass. A DMARC pass through an aligned DKIM signature outweighs a failed SPF check, which is normal
 * for forwarded mail and mailing lists.
 */
export function fromMayBeForged(ids: ReadonlySet<string>): boolean {
	if (ids.has("dmarc_failed")) return true;
	return !ids.has("dmarc_passed") && [...ids].some((id) => id.endsWith("_failed"));
}

export type AuthPolicyDecision = {
	/** Shown with the `auth_policy` signal. */
	reason: string;
	/** What triggered it: the published policy, the owner's switch, or SPF and DKIM failing without DMARC. */
	cause: "dmarc_reject" | "dmarc_quarantine" | "dmarc_strict" | "spf_and_dkim";
};

/**
 * Whether failed authentication files the message as spam (`ids`: the signal ids of `analyzeAuthentication`).
 *
 * - DMARC failed and the From domain publishes `p=reject` or `p=quarantine`, or the owner turned on **Treat every
 *   DMARC failure as spam**: yes.
 * - DMARC failed with `p=none` or a policy Kite could not learn: no; the failure only adds its points.
 * - No DMARC result, but SPF and DKIM both failed: yes, as if the domain published `p=quarantine`.
 */
export function planAuthPolicy(
	ids: ReadonlySet<string>,
	dmarc: { policy: DmarcPolicy; strict: boolean },
): AuthPolicyDecision | null {
	if (ids.has("dmarc_failed")) {
		if (dmarc.policy === "reject" || dmarc.policy === "quarantine")
			return {
				reason: `DMARC failed and the sender's domain asks receivers to ${dmarc.policy} such mail`,
				cause: dmarc.policy === "reject" ? "dmarc_reject" : "dmarc_quarantine",
			};
		if (dmarc.strict)
			return { reason: "DMARC failed, and this server treats every DMARC failure as spam", cause: "dmarc_strict" };
		return null;
	}
	if (!ids.has("dmarc_passed") && ids.has("spf_failed") && ids.has("dkim_failed"))
		return { reason: "Both SPF and DKIM failed", cause: "spf_and_dkim" };
	return null;
}
