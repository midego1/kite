import type { ReactNode } from "react";

export type EmailBodyProps = {
	/** Already sanitized HTML of the message itself; null when it has only text. */
	html: string | null;
	/** Already sanitized HTML of the quoted history, when there is any. */
	quotedHtml?: string | null;
	/** Shown instead of the frame when the message has no HTML. */
	fallback: ReactNode;
	/** Classes of the message's frame. */
	className?: string;
};
