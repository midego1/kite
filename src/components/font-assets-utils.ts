// No "use client": the root layout embeds these constants in the bootstrap script, and the reader frame
// uses them to style HTML mail. Nothing here touches the DOM.

/** A self-hosted font whose faces `globals.css` declares: the file to preload and the stylesheet for the reader frame. */
export type FontAsset = {
	/** The `font-family` the faces declare. */
	family: string;
	/** The same `@font-face` rules as a stylesheet under `public/fonts/`, for the reader frame's own document. */
	stylesheet: string;
	/** The regular weight, preloaded when the font is already chosen at page load; the others load on first use. */
	preload: string;
};

/** Marks the `<link>` the bootstrap script adds for a chosen font. */
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
 * The reader frame's override for HTML mail: the message's own fonts are replaced, except in code, which
 * keeps a monospace face. The sanitizer leaves inline `font-family` declarations out (`dropFontFamily`),
 * because an inline `!important` would otherwise beat this stylesheet.
 */
export function readerFontStyles(asset: FontAsset): string {
	return [
		`body,body *{font-family:"${asset.family}",sans-serif!important;letter-spacing:.02em;word-spacing:.08em}`,
		"pre,code,kbd,samp,tt,pre *,code *{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;letter-spacing:0;word-spacing:0}",
	].join("");
}
