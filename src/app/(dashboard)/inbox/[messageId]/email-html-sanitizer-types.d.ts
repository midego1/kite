export type SanitizeEmailHtmlOptions = {
	forOutgoing?: boolean;
	/** Drop images fetched from other hosts; they can be used as read-tracking pixels. */
	blockRemoteImages?: boolean;
	/** Incremented once per remote image dropped by `blockRemoteImages`. */
	stats?: { blockedRemoteImages: number };
	/**
	 * Id of the message being read: remote images that are shown load through the same-origin
	 * proxy, which checks the image appears in that message, instead of from their host.
	 */
	proxyRemoteImagesFor?: string;
	/** Turn web and email addresses in text (outside links and code) into links; ignored with `forOutgoing`. */
	linkify?: boolean;
};

export type EmailHtmlSanitizer = (html: string | null, options?: SanitizeEmailHtmlOptions) => string | null;
