import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A raw <button> in a form posts it natively when it is clicked before React has hydrated the page, and one outside
 * a form has no handler yet, so the click is lost. The Button component (src/components/ui/button.tsx) is disabled
 * until the page is interactive, so every action that starts a request uses it. A raw <button> must say
 * type="button" (it then only toggles or opens something); a submit button must be a Button.
 */
const ALLOWED_RAW_SUBMIT = new Map([
	["src/components/ui/button.tsx", "the Button component itself"],
	["src/components/agent/queued-messages.tsx", "the edit form only exists after a click, so the page is hydrated"],
]);

function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".tsx") ? [path] : [];
	});
}

/** The text of an opening <button …> tag, skipping the `>` of arrow functions inside attribute expressions. */
function openingTags(source) {
	const tags = [];
	for (let start = source.indexOf("<button"); start !== -1; start = source.indexOf("<button", start + 7)) {
		if (!/[\s>]/.test(source[start + 7] ?? "")) continue;
		let depth = 0;
		let index = start + 7;
		for (; index < source.length; index += 1) {
			const char = source[index];
			if (char === "{") depth += 1;
			else if (char === "}") depth -= 1;
			else if (char === ">" && depth === 0) break;
		}
		tags.push({ text: source.slice(start, index + 1), line: source.slice(0, start).split("\n").length });
	}
	return tags;
}

test('a raw <button> is always type="button"; submit buttons use the hydration-aware Button', () => {
	const offenders = [];
	for (const file of sourceFiles(join(root, "src"))) {
		const path = relative(root, file);
		if (ALLOWED_RAW_SUBMIT.has(path)) continue;
		for (const tag of openingTags(readFileSync(file, "utf8"))) {
			if (!/\btype=["']button["']/.test(tag.text)) offenders.push(`${path}:${tag.line}`);
		}
	}
	assert.deepEqual(offenders, [], 'use <Button> from @/components/ui/button, or add type="button"');
});
