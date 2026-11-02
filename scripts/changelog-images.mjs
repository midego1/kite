import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Where changelog screenshots live: static assets, so they stay out of the JavaScript bundle. */
export const IMAGE_DIRECTORY = "public/changelog";
/** The app path of a screenshot. Only this form is allowed: no remote URL, so the CSP stays strict. */
export const IMAGE_SRC = /^\/changelog\/[a-z0-9][a-z0-9._-]*\.webp$/;
export const MAX_IMAGE_BYTES = 200 * 1024;
export const MAX_IMAGE_WIDTH = 1600;

const IMAGE_MARKDOWN = /!\[([^\]\n]*)\]\(([^)\s]*)[^)]*\)/g;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** The text without fenced code blocks and `inline code`, which may show image syntax as an example. */
function withoutCode(text) {
	const kept = [];
	let fence = null;
	for (const line of String(text).split(/\r?\n/)) {
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
		} else if (marker) {
			fence = marker;
		} else {
			kept.push(line.replace(/`[^`]*`/g, ""));
		}
	}
	return kept.join("\n");
}

/** Every `![alt](src)` in `text` outside code. */
export function markdownImages(text) {
	return [...withoutCode(text).matchAll(IMAGE_MARKDOWN)].map((match) => ({ alt: match[1].trim(), src: match[2] }));
}

/** The pixel width and height from a WebP file's header (lossy, lossless and extended), or null. */
export function webpDimensions(buffer) {
	if (buffer.length < 30 || buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WEBP") {
		return null;
	}
	const kind = buffer.toString("latin1", 12, 16);
	if (kind === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
	if (kind === "VP8 ") {
		return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
	}
	if (kind === "VP8L") {
		const bits = buffer.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	return null;
}

/**
 * Problems with the screenshots a fragment or CHANGELOG.md names: alt text is required, the path must be
 * `/changelog/<name>.webp` (never a remote URL), and with `root` the file must exist in public/changelog/,
 * be a WebP of at most MAX_IMAGE_BYTES and MAX_IMAGE_WIDTH pixels wide.
 */
export function imageProblems(text, name, root) {
	const problems = [];
	for (const { alt, src } of markdownImages(text)) {
		if (!alt) problems.push(`${name}: the image ${src} has no alt text, write ![what it shows](${src})`);
		if (!IMAGE_SRC.test(src)) {
			problems.push(
				`${name}: the image "${src}" must be /changelog/<name>.webp, a file in ${IMAGE_DIRECTORY}/ (no remote URLs)`,
			);
			continue;
		}
		if (!root) continue;
		const file = path.join(root, IMAGE_DIRECTORY, path.basename(src));
		if (!existsSync(file)) {
			problems.push(`${name}: ${IMAGE_DIRECTORY}/${path.basename(src)} does not exist`);
			continue;
		}
		const { size } = statSync(file);
		if (size > MAX_IMAGE_BYTES) {
			problems.push(`${name}: ${src} is ${Math.ceil(size / 1024)} KB, the limit is ${MAX_IMAGE_BYTES / 1024} KB`);
		}
		const dimensions = webpDimensions(readFileSync(file));
		if (!dimensions) problems.push(`${name}: ${src} is not a WebP image`);
		else if (dimensions.width > MAX_IMAGE_WIDTH) {
			problems.push(`${name}: ${src} is ${dimensions.width} px wide, the limit is ${MAX_IMAGE_WIDTH} px`);
		}
	}
	return problems;
}

/** Release notes for GitHub: screenshot paths become absolute raw.githubusercontent.com URLs, which render there. */
export function absoluteImageUrls(markdown, repo = "midego1/kite", ref = "main") {
	return String(markdown).replace(
		/(!\[[^\]\n]*\]\()(\/changelog\/[a-z0-9][a-z0-9._-]*\.webp)\)/g,
		(_match, start, src) => `${start}https://raw.githubusercontent.com/${repo}/${ref}/public${src})`,
	);
}
