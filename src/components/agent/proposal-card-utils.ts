/**
 * Where a module's own approval card is: `loading` while its client chunk loads, `ready` once it drew the card,
 * `none` when the module has no card for the tool (or is unknown or off, where the server refuses anyway) and core
 * draws its own, `failed` when the chunk could not load.
 */
export type ProposalCardStatus = "loading" | "ready" | "none" | "failed";

/**
 * Why the approve button is not available yet, or null. Until the module's card is drawn the user has not seen the
 * fields it would save, so neither the core card nor a card that failed to load may approve.
 */
export function proposalCardBlock(status: ProposalCardStatus): string | null {
	if (status === "loading") return "Loading the card…";
	if (status === "failed") return "This card could not be loaded. Reload the page to review and approve it.";
	return null;
}

/** The status for a proposal: none without a module card to wait for, else what the chunk's load gave. */
export function proposalCardStatus(
	waitsForChunk: boolean,
	loaded: { card: boolean } | { failed: true } | null,
): ProposalCardStatus {
	if (!waitsForChunk) return "none";
	if (!loaded) return "loading";
	if ("failed" in loaded) return "failed";
	return loaded.card ? "ready" : "none";
}
