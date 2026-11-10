import { parseSpamSignals } from "./spam-score-details-utils";
import type { SenderAuthConcern, SenderAuthWarning } from "./sender-auth-warning-types";

/** Most serious first, so the warning lists DMARC and impersonation concerns before the softer ones. */
const CONCERN_ORDER: SenderAuthConcern[] = [
	"dmarc_failed",
	"display_name_spoof",
	"spf_failed",
	"dkim_failed",
	"dkim_unaligned",
	"reply_to_mismatch",
];

/**
 * Reads the concerns already on `messages.spam_signals` plus the display-name match the reader
 * loaded with the message — never re-checks authentication or re-scans the message itself. Returns
 * `null` for a sender with nothing to flag: every message whose mail passed cleanly, known contact
 * or not, including one that predates spam analysis (`spamSignalsRaw` is then `null`, so
 * `parseSpamSignals` returns an empty array). The exception is `spoofedContact`, computed fresh
 * from the owner's current contacts whenever the message loads (`findSpoofedSenderContact`), not
 * from `spam_signals`: a message that predates spam analysis, or whose stored signals are otherwise
 * empty, can still carry a `display_name_spoof` concern on its own.
 *
 * A DMARC pass outweighs a failed SPF or an unaligned DKIM pass, the same way the spam engine's own
 * `authPassed` rule does: a forwarder or mailing list commonly fails SPF while still passing DMARC
 * through an aligned DKIM signature, and an ESP that signs with its own domain (so its signature is
 * unaligned) but aligns on SPF still passes DMARC. Neither is worth a warning once DMARC itself
 * passed, so `spf_failed`, `dkim_failed` and `dkim_unaligned` are dropped whenever `dmarc_passed` is
 * among the stored signals.
 */
export function deriveSenderAuthWarning(
	spamSignalsRaw: string | null | undefined,
	spoofedContact: string | true | null | undefined,
): SenderAuthWarning | null {
	const signals = parseSpamSignals(spamSignalsRaw);
	const dmarcPassed = signals.some((signal) => signal.id === "dmarc_passed");
	const found = new Set<SenderAuthConcern>();
	for (const signal of signals) {
		if (signal.id === "dmarc_failed") found.add("dmarc_failed");
		else if (signal.id === "reply_to_mismatch") found.add("reply_to_mismatch");
		else if (dmarcPassed) continue;
		else if (signal.id === "spf_failed") found.add("spf_failed");
		else if (signal.id === "dkim_failed") found.add("dkim_failed");
		else if (signal.id === "dkim_passed" && signal.metadata?.aligned === false) found.add("dkim_unaligned");
	}
	if (spoofedContact) found.add("display_name_spoof");
	if (found.size === 0) return null;
	return { concerns: CONCERN_ORDER.filter((concern) => found.has(concern)), spoofedContact: spoofedContact ?? null };
}
