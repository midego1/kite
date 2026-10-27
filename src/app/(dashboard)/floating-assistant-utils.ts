type BubbleInput = {
	open: boolean;
	fullSize: boolean;
	composing: boolean;
	composerPlacement: "popup" | "inline";
};

/**
 * Where the "Ask Kite AI" bubble sits. A closed bubble would cover the send row of a floating composer, so it
 * waits until that one is gone. A reply docked in the reader never hides it, but its footer (Delete draft) runs
 * under the corner, so the bubble moves up to rest above that row while the reply is expanded.
 */
export function assistantBubblePlacement({
	open,
	fullSize,
	composing,
	composerPlacement,
}: BubbleInput): "hidden" | "corner" | "above-reply" {
	if (fullSize) return "hidden";
	if (open) return "corner";
	if (!composing) return "corner";
	return composerPlacement === "popup" ? "hidden" : "above-reply";
}
