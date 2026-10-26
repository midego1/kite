import type { SpamSignal } from "../types";
import { SPAM_WEIGHTS } from "../weights";
import { topmostAuthenticationResults } from "../authentication-results-utils";

/**
 * Signals from the `Authentication-Results` header the intake hop vouched for
 * (`InboundQueueMessage.authenticationResults`), never from the message's own headers: without one
 * the sender's authentication is unknown and adds nothing.
 */
export function analyzeAuthentication(trusted: string | null | undefined): SpamSignal[] {
	if (!trusted) return [];
	const value = topmostAuthenticationResults(trusted);
	const signals: SpamSignal[] = [];
	for (const method of ["dmarc", "dkim", "spf"] as const) {
		const result = value.match(new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`, "i"))?.[1]?.toLowerCase();
		if (result === "pass")
			signals.push({
				id: `${method}_passed`,
				score: SPAM_WEIGHTS.authentication[`${method}Pass`],
				reason: `${method.toUpperCase()} authentication passed`,
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
