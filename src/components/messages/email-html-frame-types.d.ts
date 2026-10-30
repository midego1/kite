import type { FontAsset } from "@/components/font-assets-utils";

/** What the sanitizer found in one message part's inline styles; see email-colour-utils.ts. */
export type EmailColourFacts = {
	/** Some element paints a background colour. */
	background: boolean;
	/** Some text colour stays unreadable on the dark canvas. */
	unreadable: boolean;
	/** Some text is near-black, marked `data-kite-text="neutral"`. */
	neutral: boolean;
};

export type EmailFrameDocumentOptions = {
	dark?: boolean;
	/** The sanitizer's findings for this HTML; without them dark mode leaves its colours alone. */
	colours?: EmailColourFacts;
	/** Replace the message's fonts with this self-hosted font (the dyslexia-friendly choice). */
	font?: FontAsset;
	/** Secondary text colour, for quoted history. */
	muted?: boolean;
	/** Keep the mail in its own light colours instead of adapting it to dark mode. */
	original?: boolean;
};

export type EmailHtmlFrameProps = {
	/** Already sanitized HTML. */
	html: string;
	/** The sanitizer's colour findings for `html`. */
	colours?: EmailColourFacts;
	title?: string;
	muted?: boolean;
	/** Show the sender's own colours instead of adapting them to dark mode. */
	original?: boolean;
	className?: string;
};

export type RemoteImagesNoticeProps = {
	onShow: () => void;
};
