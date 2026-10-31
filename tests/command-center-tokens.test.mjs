import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The command center's colours are --cc-* custom properties in src/app/globals.css, registered in @theme as
// --color-cc-* so components can write bg-cc-surface or text-cc-accent. A token that is registered but never set,
// or a class naming a token that does not exist, compiles without a warning and quietly draws nothing.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = await readFile(join(root, "src/app/globals.css"), "utf8");

/** The declarations of every block whose selector is exactly `selector`, merged in source order. */
function declarations(selector) {
	const values = new Map();
	for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
		// What follows the previous block or statement (`@import …;`) is the selector.
		if (match[1].split(";").at(-1).trim() !== selector) continue;
		for (const declaration of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
			values.set(declaration[1], declaration[2].trim());
	}
	return values;
}

const ccOnly = (values) => new Map([...values].filter(([name]) => name.startsWith("--cc-")));
const theme = declarations("@theme inline");
/** The --cc-* tokens @theme registers, by the utility name they give (`surface` for bg-cc-surface). */
const registered = new Map(
	[...theme].flatMap(([name, value]) => {
		const utility = /^--color-cc-([\w-]+)$/.exec(name)?.[1];
		return utility ? [[utility, value]] : [];
	}),
);
const light = ccOnly(declarations(":root"));
const dark = ccOnly(declarations(".dark"));
const overrides = [
	':root:not(.dark)[data-style="classic"]',
	':root[data-style="kite"]',
	':root.dark[data-style="kite"]',
].map((selector) => [selector, ccOnly(declarations(selector))]);

test("every command center colour @theme registers points at its own --cc-* token", () => {
	assert.ok(registered.size >= 10, "the @theme block lists the command center colours");
	for (const [utility, value] of registered) assert.equal(value, `var(--cc-${utility})`, utility);
});

test("every registered token has a value in :root, which the dark themes inherit", () => {
	for (const utility of registered.keys()) assert.ok(light.has(`--cc-${utility}`), `--cc-${utility} in :root`);
	assert.ok(light.has("--cc-elevation") && light.has("--cc-glow"));
});

test("a token with a fixed colour in :root gets its own value in .dark", () => {
	// A literal colour cannot follow the theme; one built from the theme's variables (var(--muted)) can.
	const literal = [...light].filter(([, value]) => /#[\da-f]{3,8}\b|rgba?\(/i.test(value)).map(([name]) => name);
	assert.ok(literal.length > 0);
	for (const name of literal) assert.ok(dark.has(name), `${name} has a dark value`);
});

test("the dark and style overrides only set tokens :root defines", () => {
	assert.ok(dark.size > 0);
	for (const [selector, values] of [[".dark", dark], ...overrides]) {
		assert.ok(values.size > 0, `${selector} sets command center tokens`);
		for (const name of values.keys()) assert.ok(light.has(name), `${selector} sets ${name}, which :root does not`);
	}
});

test("components only use command center colours @theme registers", async () => {
	const files = [];
	const walk = async (directory) => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (/\.tsx?$/.test(entry.name)) files.push(path);
		}
	};
	await walk(join(root, "src"));
	const used = new Set();
	for (const file of files) {
		const source = await readFile(file, "utf8");
		// bg-cc-surface, hover:border-cc-border-strong, bg-cc-accent-tint/12, decoration-cc-link-underline, …
		for (const match of source.matchAll(
			/\b(?:bg|text|border|divide|decoration|ring|outline|fill|stroke)-cc-([a-z]+(?:-[a-z]+)*)/g,
		))
			used.add(match[1]);
		// shadow-(--cc-elevation), bg-(image:--cc-glow)
		for (const match of source.matchAll(/\(\s*(?:[\w-]+:)?--cc-([\w-]+)\s*\)/g)) {
			assert.ok(light.has(`--cc-${match[1]}`), `--cc-${match[1]} (${file}) is defined in :root`);
		}
	}
	assert.ok(used.size >= 10, "the command center's classes were found");
	for (const utility of used) assert.ok(registered.has(utility), `cc-${utility} is registered in @theme`);
});
