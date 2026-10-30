export type EmailFrameDocumentOptions = {
	dark?: boolean;
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
