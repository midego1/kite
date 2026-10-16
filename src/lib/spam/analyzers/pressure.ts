import type { PreparedSpamContent, SpamSignal } from "../types";

/**
 * Text that asks the reader to undo the spam filter: whitelist the domain, mark the mail as safe or
 * never block it. Newsletters sometimes ask to be added to the address book, so that alone does not count.
 */
const SAFELIST_PRESSURE = [
	/\b(white-?list|allow-?list)\b/i,
	/\bnever block\b/i,
	/\bmark (this|the|our) (mail|e-?mail|message) as\W{0,3}(safe|not spam|not junk)\b/i,
	/\b(junk|spam) (mail )?(folder|box)\b.{0,160}\b(mark|move|flag)\b.{0,60}\b(safe|not spam|not junk|inbox)\b/is,
];

export function analyzeSafelistPressure(prepared: PreparedSpamContent): SpamSignal[] {
	if (!SAFELIST_PRESSURE.some((pattern) => pattern.test(prepared.visibleText))) return [];
	return [
		{
			id: "safelist_pressure",
			score: 12,
			reason: "Message asks you to mark it as safe or to whitelist the sender",
		},
	];
}
