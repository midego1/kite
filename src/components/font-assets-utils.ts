// No "use client": the root layout embeds these constants in the bootstrap script, and the reader frame
// uses them to style HTML mail. Nothing here touches the DOM at import time.

/** A self-hosted font that is loaded only while it is chosen: its stylesheet and the file to preload. */
export type FontAsset = {
	/** The `font-family` the stylesheet declares. */
	family: string;
	/** The `@font-face` stylesheet under `public/fonts/`. */
	stylesheet: string;
	/** The regular weight, preloaded when the font is already chosen at page load. */
	preload: string;
};

/** Marks the `<link>` elements this module adds, so a font is linked once. */
export const FONT_LINK_ATTRIBUTE = "data-kite-font";

/** The dyslexia-friendly font (SIL Open Font License 1.1, see NOTICE), keyed by its Font setting value. */
export const FONT_ASSETS: Record<"opendyslexic", FontAsset> = {
	opendyslexic: {
		family: "OpenDyslexic",
		stylesheet: "/fonts/opendyslexic/opendyslexic.css",
		preload: "/fonts/opendyslexic/opendyslexic-latin-400-normal.woff2",
	},
};

/** The asset behind a Font setting value, or undefined for the bundled and system fonts. */
export function fontAsset(value: string | null | undefined): FontAsset | undefined {
	return value && Object.hasOwn(FONT_ASSETS, value) ? FONT_ASSETS[value as keyof typeof FONT_ASSETS] : undefined;
}

/**
 * Links the font's stylesheet into `doc` once. Its files are fetched the first time text uses the family
 * (`font-display: swap`), so a font that is never chosen costs nothing.
 */
export function ensureFontStylesheet(doc: Document, value: string): void {
	const asset = fontAsset(value);
	if (!asset || doc.head.querySelector(`link[${FONT_LINK_ATTRIBUTE}="${value}"]`)) return;
	const link = doc.createElement("link");
	link.rel = "stylesheet";
	link.href = asset.stylesheet;
	link.setAttribute(FONT_LINK_ATTRIBUTE, value);
	doc.head.appendChild(link);
}

/**
 * The reader frame's override for HTML mail: the message's own fonts are replaced, except in code, which
 * keeps a monospace face. The stylesheet is linked by `<link>` because the frame has a document of its own.
 */
export function readerFontStyles(asset: FontAsset): string {
	return [
		`body,body *{font-family:"${asset.family}",sans-serif!important;letter-spacing:.02em;word-spacing:.08em}`,
		"pre,code,kbd,samp,tt,pre *,code *{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;letter-spacing:0;word-spacing:0}",
	].join("");
}
