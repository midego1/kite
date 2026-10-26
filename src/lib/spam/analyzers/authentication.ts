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
