import DOMPurify from "dompurify";
import type { Config, DOMPurify as Purifier, WindowLike } from "dompurify";
import { linkifyTextNodes } from "@/lib/email/linkify-dom-utils";
import { remoteImageProxyUrl } from "@/lib/remote-images/proxy-url-utils";
import type { EmailHtmlSanitizer, SanitizeEmailHtmlOptions } from "./email-html-sanitizer-types";

const ALLOWED_TAGS = [
	"a",
	"abbr",
	"address",
	"b",
	"blockquote",
	"br",
	"caption",
	"code",
	"col",
	"colgroup",
	"dd",
	"del",
	"div",
	"dl",
	"dt",
	"em",
	"figcaption",
	"figure",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"i",
	"img",
	"ins",
	"kbd",
	"li",
	"ol",
	"p",
	"pre",
	"q",
	"s",
	"samp",
	"small",
	"span",
	"strike",
	"strong",
	"sub",
	"sup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"u",
	"ul",
];

// Elements outside the allowlist are unwrapped and keep their text, except these,
// whose content is either code, a control or meaningless without the element.
const DROP_CONTENT_TAGS = [
	"base",
	"button",
	"embed",
	"form",
	"iframe",
	"input",
	"link",
	"math",
	"meta",
	"object",
	"option",
	"script",
	"select",
	"style",
	"svg",
	"textarea",
];

const GLOBAL_ATTRIBUTES = new Set(["dir", "lang", "style", "title"]);
const TAG_ATTRIBUTES: Record<string, Set<string>> = {
	a: new Set(["href"]),
	blockquote: new Set(["cite"]),
	col: new Set(["span", "width"]),
	// The composer finds the signature block by these markers to swap it.
	div: new Set(["data-kite-signature", "data-mailflare-signature"]),
	img: new Set(["alt", "height", "src", "width"]),
	li: new Set(["value"]),
	ol: new Set(["start", "type"]),
	table: new Set(["border", "cellpadding", "cellspacing", "width"]),
	td: new Set(["align", "colspan", "rowspan", "valign", "width"]),
	th: new Set(["align", "colspan", "rowspan", "scope", "valign", "width"]),
};
const ALLOWED_ATTRIBUTES = [
	...new Set([...GLOBAL_ATTRIBUTES, ...Object.values(TAG_ATTRIBUTES).flatMap((set) => [...set])]),
];

const ALLOWED_STYLE_PROPERTIES = new Set([
	"background-color",
	"border",
	"border-bottom",
	"border-color",
	"border-left",
	"border-radius",
	"border-right",
	"border-style",
	"border-top",
	"border-width",
	"color",
	"display",
	"font-family",
	"font-size",
	"font-style",
	"font-weight",
	"height",
	"letter-spacing",
	"line-height",
	"margin",
	"margin-bottom",
	"margin-left",
	"margin-right",
	"margin-top",
	"max-width",
	"min-width",
	"opacity",
	"padding",
	"padding-bottom",
	"padding-left",
	"padding-right",
	"padding-top",
	"text-align",
	"text-decoration",
	"text-indent",
	"text-transform",
	"vertical-align",
	"white-space",
	"width",
	"word-break",
	"word-wrap",
]);
const UNSAFE_STYLE_VALUE = /url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding/i;
const APP_FONT_FALLBACK = "var(--font-geist-sans), system-ui, sans-serif";

// Same as the links the sender wrote (target and rel), plus nofollow: nobody vouched for these.
const LINKIFIED_ANCHOR_ATTRIBUTES = { target: "_blank", rel: "noopener noreferrer nofollow" };

const PURIFY_CONFIG: Config & { RETURN_DOM: true } = {
	ALLOWED_TAGS,
	ALLOWED_ATTR: ALLOWED_ATTRIBUTES,
	ADD_FORBID_CONTENTS: DROP_CONTENT_TAGS,
	ALLOW_DATA_ATTR: false,
	ALLOW_ARIA_ATTR: false,
	ALLOW_UNKNOWN_PROTOCOLS: false,
	RETURN_DOM: true,
};

type SanitizerWindow = WindowLike & { location: { origin: string } };
type StyledElement = Element & ElementCSSInlineStyle;

function hasInlineStyle(element: Element): element is StyledElement {
	return "style" in element && typeof (element as StyledElement).style?.getPropertyValue === "function";
}

function parseUrl(value: string, origin: string, options: SanitizeEmailHtmlOptions): URL | null {
	try {
		return options.forOutgoing ? new URL(value) : new URL(value, origin);
	} catch {
		return null;
	}
}

function isSafeLinkUrl(value: string, origin: string, options: SanitizeEmailHtmlOptions): boolean {
	const url = parseUrl(value, origin, options);
	return !!url && ["http:", "https:", "mailto:", "tel:"].includes(url.protocol);
}

function isLocalImageUrl(value: string, options: SanitizeEmailHtmlOptions): boolean {
	if (!options.forOutgoing && value.startsWith("/api/messages/")) return true;
	// An imported draft names its inline attachments by Content-ID; dropping the reference would
	// lose the image on the next autosave. cid: never fetches anything.
	if (options.forOutgoing && /^cid:[^\s"'<>]+$/i.test(value)) return true;
	return /^data:image\/(?:gif|jpeg|png|webp);base64,/i.test(value);
}

function isSafeImageUrl(value: string, origin: string, options: SanitizeEmailHtmlOptions): boolean {
	if (isLocalImageUrl(value, options)) return true;
	const url = parseUrl(value, origin, options);
	if (!url) return false;
	return options.forOutgoing ? url.protocol === "https:" : url.protocol === "http:" || url.protocol === "https:";
}

/** Remote images (not this origin's, not inline data) go through the proxy when it is asked for. */
function displayedImageUrl(src: string, origin: string, options: SanitizeEmailHtmlOptions): string {
	if (!options.proxyRemoteImagesFor || options.forOutgoing || isLocalImageUrl(src, options)) return src;
	const url = parseUrl(src, origin, options);
	if (!url || url.origin === origin || (url.protocol !== "http:" && url.protocol !== "https:")) return src;
	return remoteImageProxyUrl(options.proxyRemoteImagesFor, url.href);
}

function sanitizeStyle(element: StyledElement, options: SanitizeEmailHtmlOptions): void {
	const safeDeclarations: string[] = [];
	for (const property of Array.from(element.style)) {
		if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
		if (property === "font-family" && options.dropFontFamily) continue;
		const value = element.style.getPropertyValue(property);
		if (UNSAFE_STYLE_VALUE.test(value)) continue;
		const safeValue = property === "font-family" && !options.forOutgoing ? `${value}, ${APP_FONT_FALLBACK}` : value;
		safeDeclarations.push(`${property}: ${safeValue}`);
	}
	if (safeDeclarations.length) {
		element.setAttribute("style", safeDeclarations.join("; "));
	} else {
		element.removeAttribute("style");
	}
}

function styleQuoteIntroductions(root: Element): void {
	for (const blockquote of Array.from(root.querySelectorAll("blockquote"))) {
		const introduction = blockquote.previousElementSibling;
		if (
			introduction &&
			hasInlineStyle(introduction) &&
			/^On\b[\s\S]*\bwrote:\s*$/i.test(introduction.textContent?.trim() ?? "") &&
			!introduction.style.marginTop
		) {
			introduction.style.marginTop = "1.4em";
			introduction.style.paddingBottom = "0.6em";
		}
	}
}

/** Mail-specific rules on top of DOMPurify's output: URL policy, image blocking and CSS filtering. */
function finishElement(element: Element, origin: string, options: SanitizeEmailHtmlOptions): void {
	const tag = element.tagName.toLowerCase();
	if (hasInlineStyle(element)) sanitizeStyle(element, options);

	if (tag === "a") {
		const href = element.getAttribute("href");
		if (!href || !isSafeLinkUrl(href, origin, options)) {
			element.removeAttribute("href");
		} else {
			element.setAttribute("target", "_blank");
			element.setAttribute("rel", "noopener noreferrer");
		}
	}

	if (tag === "img") {
		const src = element.getAttribute("src");
		if (!src || !isSafeImageUrl(src, origin, options)) {
			element.remove();
			return;
		}
		if (options.blockRemoteImages && !isLocalImageUrl(src, options)) {
			if (options.stats) options.stats.blockedRemoteImages += 1;
			element.remove();
			return;
		}
		element.setAttribute("src", displayedImageUrl(src, origin, options));
		element.setAttribute("loading", "lazy");
		element.setAttribute("referrerpolicy", "no-referrer");
	}
}

function createPurifier(root: SanitizerWindow): Purifier {
	const purifier = DOMPurify(root);
	purifier.addHook("uponSanitizeAttribute", (node, event) => {
		const name = event.attrName.toLowerCase();
		if (GLOBAL_ATTRIBUTES.has(name)) return;
		if (!TAG_ATTRIBUTES[node.nodeName.toLowerCase()]?.has(name)) event.keepAttr = false;
	});
	return purifier;
}

/**
 * Builds the allowlist sanitizer over a window. Browsers use the global one; tests
 * pass a jsdom window so the same DOMPurify configuration is exercised.
 */
export function createEmailHtmlSanitizer(root: SanitizerWindow): EmailHtmlSanitizer {
	const purifier = createPurifier(root);
	return (html, options = {}) => {
		if (!html) return null;
		// A leading <frameset> replaces the body, so there is no body to return.
		const body = purifier.sanitize(html, PURIFY_CONFIG) as Element | null;
		if (!body) return "";
		styleQuoteIntroductions(body);
		for (const element of Array.from(body.querySelectorAll("*"))) {
			finishElement(element, root.location.origin, options);
		}
		// Last, so the loop above never sees the new anchors: the linkifier only emits http, https
		// and mailto links, and leaves text inside existing links and code alone.
		if (options.linkify && !options.forOutgoing) linkifyTextNodes(body, LINKIFIED_ANCHOR_ATTRIBUTES);
		return body.innerHTML;
	};
}
