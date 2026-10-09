// The marker names are built from pieces so this file does not match itself.
export const MARKER = new RegExp(`\\b(${["TO" + "DO", "FIX" + "ME", "HA" + "CK"].join("|")})\\b(\\(#(\\d+)\\))?`, "g");

const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|pdf|woff2?|ttf|otf|eot|zip|gz|wasm)$/i;
// docs/quality.md has to spell the marker words out to document them.
const EXCLUDED_PATHS = new Set(["docs/quality.md"]);
const EXCLUDED_FILES = new Set(["package-lock.json", "cloudflare-env.d.ts"]);

/** @param {string} file @param {string} [contents] */
export function isScannedFile(file, contents = "") {
	const name = file.split("/").pop();
	if (EXCLUDED_PATHS.has(file) || EXCLUDED_FILES.has(name) || BINARY_EXTENSION.test(file)) return false;
	return !contents.includes("\0");
}

/**
 * @param {string} text
 * @param {string} file
 * @returns {{ file: string, line: number, marker: string, issue: number | null }[]}
 */
export function findTodoMarkers(text, file) {
	const found = [];
	text.split(/\r?\n/).forEach((content, index) => {
		for (const match of content.matchAll(MARKER))
			found.push({ file, line: index + 1, marker: match[1], issue: match[3] ? Number(match[3]) : null });
	});
	return found;
}
