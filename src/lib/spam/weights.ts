export const SPAM_THRESHOLDS = { suspicious: 40, spam: 70 } as const;

export const SPAM_WEIGHTS = {
	authentication: { dmarcFail: 18, dmarcPass: -8, dkimFail: 8, dkimPass: -4, spfFail: 6, spfPass: -2 },
	relationships: { manuallySavedContact: -15, previouslySentTo: -25 },
	reputation: { establishedSpam: 25, establishedHam: -15 },
	content: { maximum: 30 },
} as const;

/**
 * How many spam reports one phishing report counts as for the message's fingerprint, so the next copy
 * of the same campaign already has a poor reputation (three reports are needed before one counts).
 * Tokens, address and domain are trained once: a freemail domain must not turn bad from one report.
 */
export const PHISHING_FINGERPRINT_WEIGHT = 3;

export const MAX_CANDIDATE_TOKENS = 500;
export const MAX_BAYESIAN_TOKENS = 20;
export const TOKENIZER_VERSION = 1;
