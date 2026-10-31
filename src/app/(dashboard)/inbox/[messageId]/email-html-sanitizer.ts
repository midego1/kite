import { createEmailHtmlSanitizer } from "./email-html-sanitizer-utils";
import type { EmailHtmlSanitizer, SanitizeEmailHtmlOptions } from "./email-html-sanitizer-types";

let browserSanitizer: EmailHtmlSanitizer | null = null;

/**
 * The reader's allowlist over the browser's own DOM; call it only in the browser. Remote images go
 * through the same-origin proxy on both runtimes.
 */
export function sanitizeEmailHtml(html: string | null, options: SanitizeEmailHtmlOptions = {}): string | null {
	if (!html) return null;
	browserSanitizer ??= createEmailHtmlSanitizer(window);
	return browserSanitizer(html, options);
}
