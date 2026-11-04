import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Kite lays out with logical utilities (`ms-`, `pe-`, `start-`, `text-start`, `border-s`, `rounded-e`, ...) so the interface can
// mirror for right-to-left languages. This test fails on a new physical utility in `src/`. A physical one that is right on
// purpose goes in ALLOWED below with the reason; an entry nothing matches any more fails too, so the list cannot go stale.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(root, "src");

// Tailwind utilities, with any variants stripped: `md:pl-3`, `data-[open]:-mr-1` and `!text-left` are all caught.
const PHYSICAL_UTILITY = new RegExp(
	"^-?(?:" +
		[
			"(?:m|p|scroll-m|scroll-p)[lr]-.+",
			"(?:left|right)-(?:\\d.*|\\[.*|auto|px|full)",
			"text-(?:left|right)",
			"border-[lr](?:-.+)?",
			"rounded-(?:l|r|tl|tr|bl|br)(?:-.+)?",
			"float-(?:left|right)",
			"clear-(?:left|right)",
			"origin-(?:top-|bottom-)?(?:left|right)",
		].join("|") +
		")$",
);
// Plain CSS and CSS-in-strings (`globals.css`, inline style strings, injected stylesheets), and inline style object keys.
const PHYSICAL_PROPERTY =
	/(?<![\w-])(?:margin|padding|border)-(?:left|right)\s*:|(?<![\w-])text-align\s*:\s*(?:left|right)\b|(?<![\w-])float\s*:\s*(?:left|right)\b|\b(?:margin|padding|border)(?:Left|Right)\s*:|\btextAlign\s*:\s*["'](?:left|right)["']/;
const CSS_POSITION = /^\s*(?:left|right)\s*:/;

/**
 * Physical utilities that stay physical. `token` is the exact class (or CSS property text) as written; each entry may
 * match several lines in its file. Keep reasons specific: they are the review record for the logical-CSS work.
 */
const ALLOWED = [
	// Centring with a physical offset and the matching translate: it centres the same way in either direction.
	...[
		"src/app/home-mailbox-overlays.tsx",
		"src/app/(dashboard)/floating-assistant-window.tsx",
		"src/components/mobile-tab-bar.tsx",
		"src/components/section-nav-sheet.tsx",
		"src/components/ui/confirm-dialog.tsx",
		"src/components/ui/dialog.tsx",
		"src/components/shortcuts/command-palette.tsx",
		"src/components/compose/compose-frame.ts",
	].map((file) => ({
		file,
		token: /^(?:md:)?left-1\/2$/,
		reason: "centred with -translate-x-1/2, which centres identically in either direction",
	})),
	{
		file: "src/components/ui/resizable.tsx",
		token: /^(?:aria-\[orientation=horizontal\]:)?after:left-(?:1\/2|0)$/,
		reason: "the divider's hit area is centred on a pane edge the drag code measures physically",
	},
	// Floating windows docked to a screen corner: their size and offsets are computed from each other in JS and CSS.
	{
		file: "src/components/compose/compose-frame.ts",
		token: /^(?:md:)?right-(?:8|\[calc\(3rem\+min\(var\(--assistant-window-width,440px\),100vw-32px\)\)\])$/,
		reason: "the docked composer mirrors the assistant window's right-8 and its resizable width; they move together",
	},
	{
		file: "src/app/(dashboard)/floating-assistant-window.tsx",
		token: /^(?:right-8|left-0)$/,
		reason: "the assistant window is docked at the right edge and resized from its left edge by a physical drag delta",
	},
	{
		file: "src/app/(dashboard)/dashboard-shell.tsx",
		token: "left-1",
		reason: "the resize handle of the assistant pane sits on the pane's physical left edge; the drag delta is physical",
	},
	{
		file: "src/components/ui/resize-handle.tsx",
		token: "right-0",
		reason:
			"the vertical resize handle straddles the physical right edge of the pane it resizes; the drag delta is physical",
	},
	{
		file: "src/components/ui/toast-styles.ts",
		token: "right-[var(--kite-toast-inset)]",
		reason: "toasts stand at the physical bottom right and clear the docked composer through --kite-toast-inset",
	},
	// Sheets and drawers docked to a physical side.
	{
		file: "src/components/ui/sheet.tsx",
		token: /^(?:left-0|right-0)$/,
		reason: "the `side` prop names a physical side, and sheet-content animates from it (globals.css)",
	},
	{
		file: "src/components/finance/subscription-drawer.tsx",
		token: /^(?:left-auto|right-0|rounded-l-2xl)$/,
		reason: "a dialog docked to the physical right edge with its rounded corners on the left",
	},
	{
		file: "src/components/sidebar-footer.tsx",
		token: /^(?:left-0\.5|left-3\.5)$/,
		reason: "the toggle knob animates `left` (transition-[left]) between two physical positions",
	},
	{
		file: "src/app/home-mailbox.tsx",
		token: /^p[lr]-\[env\(safe-area-inset-(?:left|right)\)\]$/,
		reason: "safe-area insets are physical device edges (a notch), not reading directions",
	},
	{
		file: "src/components/startup-steps.tsx",
		token: /^(?:motion-reduce:)?border-r-(?:transparent|blue-600)$/,
		reason: "the spinner is drawn by leaving one physical border side transparent",
	},
	// CSS
	{
		file: "src/app/globals.css",
		token: /^\s*padding-(?:left|right): var\(--kite-fold-(?:left|right), 0px\);$/,
		reason: "the fold hinge reports physical display segments (Viewport Segments)",
	},
	{
		file: "src/app/globals.css",
		token: /^\s*(?:left|right): .+;$/,
		reason:
			"decorative kite flight and reload animations are placed and moved physically; sheet-content keyframes name physical sides",
	},
	{
		file: "src/app/globals.css",
		token: /^\s*margin-left: calc\(var\(--reload-return-width\) \/ -2\);$/,
		reason: "centres the reload-return scene (left: 50%) with a matching physical negative margin",
	},
	{
		file: "src/components/message-actions/utils.ts",
		token: "border-left:1px solid #ccc;padding-left:1ex",
		reason: "the quoted original inside outgoing mail: the receiving client, not Kite, decides the direction",
	},
	{
		file: "src/components/compose/send-preview-utils.ts",
		token: "border-left:1px solid #ccc;padding-left:1ex",
		reason: "the same quote style as sent mail, shown in the send preview so it matches what is sent",
	},
];

function walk(directory, files = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) walk(path, files);
		else if (/\.(?:tsx?|css)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
	}
	return files;
}

function splitVariants(token) {
	const parts = [];
	let depth = 0;
	let current = "";
	for (const character of token) {
		if (character === "[" || character === "(") depth += 1;
		if (character === "]" || character === ")") depth -= 1;
		if (character === ":" && depth === 0) {
			parts.push(current);
			current = "";
		} else current += character;
	}
	parts.push(current);
	return parts;
}

/** The physical utilities and properties found in one line of source, as written. */
export function physicalHits(line, isCss) {
	if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return [];
	const hits = [];
	for (const raw of line.split(/[\s"'`{}]+/)) {
		if (!raw) continue;
		const base = splitVariants(raw).pop().replace(/^!|!$/g, "");
		if (PHYSICAL_UTILITY.test(base)) hits.push(raw);
	}
	const property = PHYSICAL_PROPERTY.exec(line);
	if (property) hits.push(line.slice(property.index).trim());
	if (isCss && CSS_POSITION.test(line)) hits.push(line.trim());
	return hits;
}

function allowed(file, hit) {
	return ALLOWED.filter(
		(entry) =>
			entry.file === file &&
			(typeof entry.token === "string" ? hit === entry.token || hit.includes(entry.token) : entry.token.test(hit)),
	);
}

const used = new Set();
const violations = [];
for (const path of walk(srcRoot)) {
	const file = relative(root, path).split("\\").join("/");
	const isCss = path.endsWith(".css");
	readFileSync(path, "utf8")
		.split("\n")
		.forEach((line, index) => {
			for (const hit of physicalHits(line, isCss)) {
				const entries = allowed(file, hit);
				if (entries.length === 0) violations.push(`${file}:${index + 1}  ${hit}`);
				for (const entry of entries) used.add(entry);
			}
		});
}

test("src uses logical utilities, not physical ones", () => {
	assert.deepEqual(
		violations,
		[],
		`Physical CSS in src/. Use ms-/me-/ps-/pe-/start-/end-/text-start/text-end/border-s/border-e/rounded-s/rounded-e (or the logical property in CSS), or add an entry with a reason to ALLOWED in tests/logical-css.test.mjs:\n${violations.join("\n")}`,
	);
});

test("every allowed physical utility is still used", () => {
	const stale = ALLOWED.filter((entry) => !used.has(entry)).map((entry) => `${entry.file}: ${entry.token}`);
	assert.deepEqual(stale, [], `Remove allowlist entries nothing matches any more:\n${stale.join("\n")}`);
});

test("the detector separates physical from logical utilities", () => {
	const hits = (text) => physicalHits(text, false);
	assert.deepEqual(hits('className="ml-2 md:pr-3 -mr-1 text-left left-0 right-auto border-l-2 rounded-tl-lg"'), [
		"ml-2",
		"md:pr-3",
		"-mr-1",
		"text-left",
		"left-0",
		"right-auto",
		"border-l-2",
		"rounded-tl-lg",
	]);
	assert.deepEqual(
		hits('className="ms-2 md:pe-3 -me-1 text-start start-0 end-auto border-s-2 rounded-ss-lg text-center"'),
		[],
	);
	assert.deepEqual(
		hits('className="data-[side=left]:ml-1 group-hover:pr-[9.25rem] pl-[env(safe-area-inset-left)]"').sort(),
		["data-[side=left]:ml-1", "group-hover:pr-[9.25rem]", "pl-[env(safe-area-inset-left)]"],
	);
	assert.deepEqual(
		hits('const label = "right-to-left text, left-to-right text, right-click, safe-area-inset-left";'),
		[],
	);
	assert.deepEqual(hits("// ml-2 in a comment"), []);
	assert.deepEqual(hits("border-left: 2px solid red;"), ["border-left: 2px solid red;"]);
	assert.deepEqual(hits("padding-inline-start: 1rem; margin-inline: auto;"), []);
	assert.deepEqual(physicalHits("\tleft: 50%;", true), ["left: 50%;"]);
	assert.deepEqual(physicalHits("\tinset-inline-start: 50%;", true), []);
});
