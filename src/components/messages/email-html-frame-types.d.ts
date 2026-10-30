import type { FontAsset } from "@/components/font-assets-utils";

export type EmailFrameDocumentOptions = {
	dark?: boolean;
	/** Replace the message's fonts with this self-hosted font (the dyslexia-friendly choice). */
	font?: FontAsset;
	/** Secondary text colour, for quoted history. */
	muted?: boolean;
	/** Keep designed mail in its own light colours instead of inverting it in dark mode. */
	original?: boolean;
};

export type EmailHtmlFrameProps = {
	/** Already sanitized HTML. */
	html: string;
	title?: string;
	muted?: boolean;
	className?: string;
};

export type RemoteImagesNoticeProps = {
	onShow: () => void;
};
