export type SanitizeEmailHtmlOptions = {
	forOutgoing?: boolean;
	/** Drop images fetched from other hosts; they can be used as read-tracking pixels. */
	blockRemoteImages?: boolean;
	/** Incremented once per remote image dropped by `blockRemoteImages`. */
	stats?: { blockedRemoteImages: number };
};
