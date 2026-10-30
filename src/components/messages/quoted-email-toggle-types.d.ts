import type { EmailColourFacts } from "./email-html-frame-types";

export type QuotedEmailToggleProps = {
	html: string;
	/** The sanitizer's colour findings for `html`. */
	colours?: EmailColourFacts;
	/** Follows the message's "Original colours" button. */
	original?: boolean;
};
