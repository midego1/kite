export type EmailFrameDocumentOptions = {
	dark?: boolean;
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
