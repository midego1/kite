import type { EmailColourFacts } from "@/components/messages/email-html-frame-types";

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
	/**
	 * Leave `font-family` out of inline styles, for the reader font that replaces the message's fonts
	 * (Settings → Appearance → Font in HTML emails): an inline `!important` would otherwise beat it.
	 */
	dropFontFamily?: boolean;
	/**
	 * Filled in from each element's parsed inline style, for the reader's dark mode: whether any element paints a
	 * background or sets a text colour that stays unreadable on dark. Near-black text is also marked
	 * `data-kite-text="neutral"` (a data attribute from the sender never survives, so it cannot be forged).
	 * Ignored with `forOutgoing`, and nothing is marked unless it is given.
	 */
	colours?: EmailColourFacts;
};

export type EmailHtmlSanitizer = (html: string | null, options?: SanitizeEmailHtmlOptions) => string | null;
