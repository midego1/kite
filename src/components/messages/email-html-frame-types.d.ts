import type { FontAsset } from "@/components/font-assets-utils";

export type EmailFrameDocumentOptions = {
	dark?: boolean;
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
	title?: string;
	muted?: boolean;
	/** Show the sender's own colours instead of adapting them to dark mode. */
	original?: boolean;
	className?: string;
};

export type RemoteImagesNoticeProps = {
	onShow: () => void;
};
