import type { ChangelogImage } from "./types";

/**
 * Where changelog screenshots live: static WebP files in `public/changelog/`, so they never count toward the
 * JavaScript and never come from another origin (the Content-Security-Policy stays as strict as it is).
 * `scripts/changelog-images.mjs` applies the same rule to fragments and CHANGELOG.md.
 */
const IMAGE_SRC = /^\/changelog\/[a-z0-9][a-z0-9._-]*\.webp$/;
const IMAGE_MARKDOWN = /\s*!\[([^\]\n]*)\]\((\/[^)\s]*)\)/g;
/** A line that is nothing but images, written under the bullet it belongs to. */
const IMAGE_ONLY_LINE = /^(?:!\[[^\]\n]*\]\(\/[^)\s]*\)\s*)+$/;

/** Whether `src` names a screenshot in `public/changelog/`. */
function isChangelogImageSrc(src: string): boolean {
	return IMAGE_SRC.test(src);
}

/** Whether a whole line is image markdown only. */
export function isImageOnlyLine(line: string): boolean {
	return IMAGE_ONLY_LINE.test(line.trim());
}

/**
 * Pulls the `![alt](/changelog/x.webp)` images out of one item. An image without alt text, or one that does
 * not point into `/changelog/`, is not an image: it stays in the text as literal characters.
 */
export function splitChangelogImages(item: string): { text: string; images: ChangelogImage[] } {
	const images: ChangelogImage[] = [];
	const text = item.replace(IMAGE_MARKDOWN, (full, alt: string, src: string) => {
		if (!alt.trim() || !isChangelogImageSrc(src)) return full;
		images.push({ alt: alt.trim(), src });
		return "";
	});
	return { text: images.length ? text.trim() : item, images };
}

/** Whether an item carries at least one screenshot. */
export function hasChangelogImages(item: string): boolean {
	return splitChangelogImages(item).images.length > 0;
}
