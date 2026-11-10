import type { SpamSignal } from "../types";
import { SPAM_WEIGHTS } from "../weights";
import { type AuthenticationResult, parseAuthenticationResults } from "../authentication-results-utils";
import { sameRegistrableDomain } from "./link-host-utils";

type Method = "dmarc" | "dkim" | "spf";

const domainOf = (value: string | undefined) => value?.slice(value.lastIndexOf("@") + 1).toLowerCase() ?? "";

/** The signing domain of a DKIM result: `header.d`, else the domain of `header.i`. */
function dkimDomain(entry: AuthenticationResult): string {
	return domainOf(entry.properties["header.d"] ?? entry.properties["header.i"]);
}

/**
 * Relaxed DKIM alignment (RFC 7489 §3.1.1): the signing domain and the From domain share an
 * organizational domain, approximated by `registrableDomain`.
 */
function aligned(entry: AuthenticationResult, fromDomain: string): boolean {
	const domain = dkimDomain(entry);
	return !!domain && !!fromDomain && sameRegistrableDomain(domain, fromDomain);
}

/**
 * Whether the DMARC result names the From domain as `header.from` (`match`), another domain (`mismatch`: a pass for
 * a domain the message only mentions), or none (`absent`: SES, whose verdict is for the From header it saw).
 */
function headerFromState(entry: AuthenticationResult, fromDomain: string): "match" | "mismatch" | "absent" {
	const headerFrom = entry.properties["header.from"]?.trim().toLowerCase().replace(/\.$/, "");
	if (!headerFrom) return "absent";
	return headerFrom === fromDomain.toLowerCase().replace(/\.$/, "") ? "match" : "mismatch";
}

/**
 * The result that speaks for each method. SPF: the `smtp.mailfrom` check, since Cloudflare also
 * reports the HELO check first, else one that is not a HELO check. DKIM: a pass from any signature,
 * else a failure. DMARC: the first one.
 */
function pick(results: AuthenticationResult[], method: Method): AuthenticationResult[] {
	const ofMethod = results.filter((entry) => entry.method === method);
	if (method === "spf") {
		const mailfrom = ofMethod.find((entry) => entry.properties["smtp.mailfrom"]);
		const other = ofMethod.find((entry) => !entry.properties["smtp.helo"]);
		return mailfrom ? [mailfrom] : other ? [other] : [];
	}
	if (method === "dkim") {
		const passes = ofMethod.filter((entry) => entry.result === "pass");
		return passes.length ? passes : ofMethod.slice(0, 1);
	}
	return ofMethod.slice(0, 1);
}

/**
 * Signals from the `Authentication-Results` header the intake hop vouched for
 * (`InboundQueueMessage.authenticationResults`), never from the message's own headers: without one
 * the sender's authentication is unknown and adds nothing. `dkim_passed` records in `aligned`
 * whether a passing signature belongs to the From domain's organization.
 */
export function analyzeAuthentication(trusted: string | null | undefined, fromDomain = ""): SpamSignal[] {
	if (!trusted) return [];
	const { results } = parseAuthenticationResults(trusted);
	const signals: SpamSignal[] = [];
	for (const method of ["dmarc", "dkim", "spf"] as const) {
		const entries = pick(results, method);
		const result = entries[0]?.result;
		if (result === "pass")
			signals.push({
				id: `${method}_passed`,
				score: SPAM_WEIGHTS.authentication[`${method}Pass`],
				reason: `${method.toUpperCase()} authentication passed`,
				...(method === "dkim"
					? { metadata: { aligned: entries.some((entry) => aligned(entry, fromDomain.toLowerCase())) } }
					: method === "dmarc"
						? { metadata: { headerFrom: headerFromState(entries[0]!, fromDomain) } }
						: {}),
			});
		if (result === "fail")
			signals.push({
				id: `${method}_failed`,
				score: SPAM_WEIGHTS.authentication[`${method}Fail`],
				reason: `${method.toUpperCase()} authentication failed`,
			});
	}
	return signals;
}

/**
 * The From domain when the sender authenticated as it, else null: a DMARC pass whose `header.from` is that domain
 * (a pass that names none, or another domain the message mentions, does not count), or an aligned
 * DKIM pass with no failed check. Like `authPassed` in the automatic-reading facts, plus the `header.from` check.
 */
export function authenticatedSenderDomain(
	trusted: string | null | undefined,
	signals: readonly SpamSignal[],
	fromDomain: string,
): string | null {
	const from = fromDomain.toLowerCase().replace(/\.$/, "");
	if (!trusted || !from) return null;
	const dmarc = parseAuthenticationResults(trusted).results.find((entry) => entry.method === "dmarc");
	const headerFrom = dmarc?.properties["header.from"]?.trim().toLowerCase().replace(/\.$/, "");
	const dmarcPassed = dmarc?.result === "pass" && headerFrom === from;
	const failed = signals.some((signal) => signal.id.endsWith("_failed"));
	const dkimAligned = signals.some((signal) => signal.id === "dkim_passed" && signal.metadata?.aligned === true);
	return dmarcPassed || (!failed && dkimAligned) ? from : null;
}
