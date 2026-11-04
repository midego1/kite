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
			"(?:left|right)-(?:\\d.*|\\[.*|\\(.*|auto|px|full)",
			"text-(?:left|right)",
			"border-[lr](?:-.+)?",
			"rounded-(?:l|r|tl|tr|bl|br)(?:-.+)?",
			"float-(?:left|right)",
			"clear-(?:left|right)",
			"origin-(?:top-|bottom-)?(?:left|right)",
		].join("|") +
		")$",
);
// An arbitrary property naming a physical side: `[left:4px]`, `[margin-right:1rem]`, `[text-align:left]`.
const PHYSICAL_ARBITRARY =
	/^\[(?:(?:left|right|(?:margin|padding|border|scroll-margin|scroll-padding)-(?:left|right)(?:-[a-z]+)?|border-(?:top|bottom)-(?:left|right)-radius):|(?:text-align|float|clear):(?:left|right)\b)/;
// Plain CSS and CSS-in-strings (`globals.css`, inline style strings, injected stylesheets), and inline style object keys.
// Not looked for, because they would mostly find code that is right: `left`/`right` as inline style keys and inside
// `cssText` (a position measured with getBoundingClientRect is physical on purpose, and off-screen hosts do not matter).
const PHYSICAL_PROPERTY = new RegExp(
	[
		"(?<![\\w\\[-])(?:margin|padding|border|scroll-margin|scroll-padding)-(?:left|right)(?:-(?:color|style|width))?\\s*:",
		"(?<![\\w\\[-])border-(?:top|bottom)-(?:left|right)-radius\\s*:",
		"(?<![\\w\\[-])text-align\\s*:\\s*(?:left|right)\\b",
		"(?<![\\w\\[-])float\\s*:\\s*(?:left|right)\\b",
		"\\b(?:margin|padding|border|scrollMargin|scrollPadding)(?:Left|Right)(?:Color|Style|Width)?\\s*:",
		"\\bborder(?:Top|Bottom)(?:Left|Right)Radius\\s*:",
		"\\btextAlign\\s*:\\s*[\"'](?:left|right)[\"']",
	].join("|"),
);
const CSS_POSITION = /^\s*(?:left|right)\s*:/;
// A logical offset moved by a physical translate only lines up in one direction (`start-1/2 -translate-x-1/2`).
const LOGICAL_OFFSET = /^-?(?:start|end)-/;
const NONZERO_TRANSLATE = /^-?translate-x-(?!0$)/;

/**
 * Physical utilities that stay physical. `token` is the exact class or CSS declaration as written (a string must equal
 * the whole hit; use a RegExp for a family, or for a declaration with more text behind it), and `rule` optionally the
 * CSS rule it must be in. Each entry may match several lines in its file. Keep reasons specific: they are the review
 * record for the logical-CSS work.
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
	{
		file: "src/components/finance/subscription-drawer.tsx",
		token: /^(?:left-auto|right-0|rtl:left-0|rtl:right-auto)$/,
		reason:
			"DialogContent centres with a physical left-1/2, and Tailwind puts left after start/end, so the drawer can only undo it physically, per direction",
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
		rule: /^\.fold-hinge\b/,
		token: /^padding-(?:left|right): var\(--kite-fold-(?:left|right), 0px\);$/,
		reason: "the fold hinge reports physical display segments (Viewport Segments)",
	},
	{
		file: "src/app/globals.css",
		rule: /^\.reload-return-(?:arrive|cloud-[12]|wind|wind-2|static)\b/,
		token: /^(?:left: (?:50%|6%|0|calc\(50% \+ [46]rem\))|right: (?:4%|0));$/,
		reason: "the decorative reload scene: the kite, clouds and wind are placed physically and fly one way",
	},
	{
		file: "src/app/globals.css",
		rule: /^\.reload-return-arrive\b/,
		token: "margin-left: calc(var(--reload-return-width) / -2);",
		reason: "centres the reload-return scene (left: 50%) with a matching physical negative margin",
	},
	{
		file: "src/app/globals.css",
		rule: /^html\[dir="rtl"\] \.text-(?:start|end)\b/,
		token: /^text-align: (?:left|right);$/,
		reason:
			"only in a right-to-left interface, where unicode-bidi: plaintext would make start and end follow the text rather than the interface",
	},
	{
		file: "src/components/message-actions/utils.ts",
		token: /^border-left:1px solid #ccc;padding-left:1ex;opacity:0\.6";$/,
		reason: "the quoted original inside outgoing mail: the receiving client, not Kite, decides the direction",
	},
	{
		file: "src/components/compose/send-preview-utils.ts",
		token: /^border-left:1px solid #ccc;padding-left:1ex}",$/,
		reason: "the same quote style as sent mail, shown in the send preview so it matches what is sent",
	},
];

function walk(directory, files = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) walk(path, files);
		else if (/\.(?:tsx?|s?css)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
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

/** Where a block comment opens in `text`, skipping any `/*` inside a string on the line (an ARN, `accept="image/*"`). */
function commentOpening(text) {
	let quote = null;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (quote) {
			if (character === "\\") index += 1;
			else if (character === quote) quote = null;
		} else if (character === '"' || character === "'" || character === "`") quote = character;
		else if (character === "/" && text[index + 1] === "*") return index;
	}
	return -1;
}

/**
 * The line without its comments, tracking a block comment across lines in `state`. Code after a closed `/* ... *\/` still
 * counts; a line that opens with `//` is a comment to its end, in code only (a CSS `//` is not one).
 */
export function withoutComments(line, state, isCss) {
	let code = "";
	let rest = line;
	while (rest) {
		if (state.inBlock) {
			const close = rest.indexOf("*/");
			if (close === -1) return code;
			state.inBlock = false;
			rest = rest.slice(close + 2);
		}
		const open = commentOpening(rest);
		if (open === -1) {
			code += rest;
			break;
		}
		code += rest.slice(0, open);
		rest = rest.slice(open + 2);
		state.inBlock = true;
	}
	return !isCss && /^\s*\/\//.test(code) ? "" : code;
}

/** The physical utilities and properties found in one line of source, as written. */
export function physicalHits(line, isCss, state = { inBlock: false }) {
	const code = withoutComments(line, state, isCss);
	const hits = [];
	const tokens = code
		.split(/[\s"'`{}]+/)
		.filter(Boolean)
		.map((raw) => {
			const variants = splitVariants(raw);
			return { raw, base: variants.pop().replace(/^!|!$/g, ""), prefix: variants.join(":") };
		});
	for (const { raw, base } of tokens) {
		if (PHYSICAL_UTILITY.test(base) || PHYSICAL_ARBITRARY.test(base)) hits.push(raw);
	}
	// A logical offset with a non-zero translate of the same variants needs its `rtl:` opposite.
	for (const { raw, base, prefix } of tokens) {
		if (!NONZERO_TRANSLATE.test(base)) continue;
		const offset = tokens.some((token) => LOGICAL_OFFSET.test(token.base) && token.prefix === prefix);
		const flipped = tokens.some(
			(token) => token.prefix === `rtl${prefix ? `:${prefix}` : ""}` && NONZERO_TRANSLATE.test(token.base),
		);
		if (offset && !flipped && !prefix.split(":").includes("rtl")) hits.push(raw);
	}
	const property = PHYSICAL_PROPERTY.exec(code);
	if (property) hits.push(code.slice(property.index).trim());
	if (isCss && CSS_POSITION.test(code)) hits.push(code.trim());
	return hits;
}

function matches(entry, file, hit, rule) {
	if (entry.file !== file || (entry.rule && !entry.rule.test(rule))) return false;
	return typeof entry.token === "string" ? hit === entry.token : entry.token.test(hit);
}

const used = new Set();
const violations = [];
for (const path of walk(srcRoot)) {
	const file = relative(root, path).split("\\").join("/");
	const isCss = /\.s?css$/.test(path);
	const state = { inBlock: false };
	let rule = "";
	readFileSync(path, "utf8")
		.split("\n")
		.forEach((line, index) => {
			for (const hit of physicalHits(line, isCss, state)) {
				const entries = ALLOWED.filter((entry) => matches(entry, file, hit, rule));
				if (entries.length === 0) violations.push(`${file}:${index + 1}  ${hit}`);
				for (const entry of entries) used.add(entry);
			}
			// The innermost rule a declaration on a later line is in.
			if (isCss && /\{\s*$/.test(line)) rule = line.trim();
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

test("the detector catches the forms a substring or a coarse pattern used to let through", () => {
	const hits = (text) => physicalHits(text, false);
	// Arbitrary properties and the `(--var)` shorthand.
	assert.deepEqual(hits('className="[left:4px] md:[margin-right:1rem] [text-align:left] left-(--x) -right-(--y)"'), [
		"[left:4px]",
		"md:[margin-right:1rem]",
		"[text-align:left]",
		"left-(--x)",
		"-right-(--y)",
	]);
	assert.deepEqual(hits('className="[inset-inline-start:4px] [text-align:start] [leftover:1px]"'), []);
	// CSS longhands, in CSS and as style keys.
	for (const declaration of [
		"border-left-color: red;",
		"border-right-width: 1px;",
		"border-top-left-radius: 2px;",
		"border-bottom-right-radius: 2px;",
		"scroll-margin-left: 1rem;",
		"scroll-padding-right: 1rem;",
	])
		assert.deepEqual(physicalHits(declaration, true), [declaration], declaration);
	assert.equal(hits("borderTopLeftRadius: 2,").length, 1);
	assert.equal(hits("scrollMarginLeft: 2,").length, 1);
	assert.equal(hits("borderLeftColor: x,").length, 1);
	assert.deepEqual(physicalHits("border-start-start-radius: 2px;", true), []);
	// A logical offset with a physical translate, unless the translate also flips.
	assert.deepEqual(hits('className="start-1/2 -translate-x-1/2"'), ["-translate-x-1/2"]);
	assert.deepEqual(hits('className="md:end-0 md:translate-x-1/2"'), ["md:translate-x-1/2"]);
	assert.deepEqual(hits('className="end-0 translate-x-1/2 rtl:-translate-x-1/2"'), []);
	assert.deepEqual(hits('className="start-0 translate-x-0"'), []);
	assert.deepEqual(hits('className="start-0 md:translate-x-1/2"'), []);
});

test("a comment only hides what is inside it", () => {
	const hits = (text, isCss = false, state) => physicalHits(text, isCss, state);
	assert.deepEqual(hits('/* note */ className="ml-2"'), ["ml-2"]);
	assert.deepEqual(hits("/* note */ margin-left: 1px;", true), ["margin-left: 1px;"]);
	assert.deepEqual(hits('{/* ml-2 */} <div className="mr-2" />'), ["mr-2"]);
	assert.deepEqual(hits("/* ml-2 */"), []);
	assert.deepEqual(hits("// ml-2"), []);
	// A `/*` in a string opens nothing, on this line or the next.
	const inString = { inBlock: false };
	assert.deepEqual(hits('const route = "/*"; className="ml-2"', false, inString), ["ml-2"]);
	assert.deepEqual(hits("Resource: `arn:aws:s3:::${bucket}/*`,", false, inString), []);
	assert.deepEqual(hits('className="mr-2"', false, inString), ["mr-2"]);
	const state = { inBlock: false };
	assert.deepEqual(hits("/** first line", false, state), []);
	assert.deepEqual(hits(" * ml-2 in the block", false, state), []);
	assert.deepEqual(hits(' */ const a = "ml-2";', false, state), ["ml-2"]);
	assert.deepEqual(hits('const b = "mr-2";', false, state), ["mr-2"]);
	// Outside a block comment, a line starting with `*` is code, such as a multiplication or a CSS hack.
	assert.deepEqual(hits('* "ml-2"'), ["ml-2"]);
});

test("a string token in the allowlist must equal the hit", () => {
	const entry = { file: "a.tsx", token: "left-1" };
	assert.equal(matches(entry, "a.tsx", "left-1", ""), true);
	assert.equal(matches(entry, "a.tsx", "left-10", ""), false);
	assert.equal(matches(entry, "a.tsx", "md:left-1", ""), false);
	assert.equal(matches(entry, "b.tsx", "left-1", ""), false);
	const inRule = { file: "a.css", rule: /^\.kite\b/, token: "left: 0;" };
	assert.equal(matches(inRule, "a.css", "left: 0;", ".kite {"), true);
	assert.equal(matches(inRule, "a.css", "left: 0;", ".other {"), false);
});
