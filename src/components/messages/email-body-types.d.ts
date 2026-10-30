import type { ReactNode } from "react";
import type { EmailColourFacts } from "./email-html-frame-types";

export type EmailBodyProps = {
	/** Already sanitized HTML of the message itself; null when it has only text. */
	html: string | null;
	/** The sanitizer's colour findings for `html`. */
	colours?: EmailColourFacts;
	/** Already sanitized HTML of the quoted history, when there is any. */
	quotedHtml?: string | null;
	/** The sanitizer's colour findings for `quotedHtml`. */
	quotedColours?: EmailColourFacts;
	/** Shown instead of the frame when the message has no HTML. */
	fallback: ReactNode;
	/** Classes of the message's frame. */
	className?: string;
};
