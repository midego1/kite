import { createEmailHtmlSanitizer } from "./email-html-sanitizer-utils";
import type { EmailHtmlSanitizer, SanitizeEmailHtmlOptions } from "./email-html-sanitizer-types";

let browserSanitizer: EmailHtmlSanitizer | null = null;

/**
 * The reader's allowlist over the browser's own DOM; call it only in the browser. The root
 * layout marks the self-hosted runtime, whose server does not proxy remote images, and there
 * they keep loading from their host.
 */
export function sanitizeEmailHtml(html: string | null, options: SanitizeEmailHtmlOptions = {}): string | null {
	if (!html) return null;
	browserSanitizer ??= createEmailHtmlSanitizer(window);
	const proxyAvailable = document.documentElement.dataset.remoteImageProxy !== "off";
	return browserSanitizer(html, proxyAvailable ? options : { ...options, proxyRemoteImagesFor: undefined });
}
