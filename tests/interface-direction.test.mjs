import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-interface-direction-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function load(entry, name) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, `${name}.mjs`),
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		tsconfig: join(root, "tsconfig.json"),
		logLevel: "silent",
	});
	return import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
}

const direction = await load("src/components/interface-direction-utils.ts", "direction");
const languages = await load("src/lib/i18n/language-utils.ts", "languages");
const { isolateDirection } = await load("src/lib/bidi-utils.ts", "bidi");
const { tooltipSide } = await load("src/components/ui/tooltip-utils.ts", "tooltip");
const { readingPaneOptions } = await load("src/components/messages/reading-layout-utils.ts", "reading");

/** Runs `run` with `<html dir>` set, as the browser would have it. */
function withDocumentDirection(dir, run) {
	const previous = globalThis.document;
	globalThis.document = { documentElement: { dir } };
	try {
		return run();
	} finally {
		globalThis.document = previous;
	}
}

const LANGUAGES = [
	["ar", true],
	["ar-EG", true],
	["AR-eg", true],
	["he", true],
	["he-IL", true],
	["iw", true],
	["fa-IR", true],
	["ur", true],
	["ur-PK", true],
	["ps", true],
	["ckb", true],
	["yi", true],
	["pa-Arab", true],
	["az-Arab-IR", true],
	["ar-Latn", false],
	["sd-Deva", false],
	["en", false],
	["en-US", false],
	["nl-NL", false],
	["art", false],
	["arn", false],
	["fr", false],
	["heb", false],
	["", false],
	[null, false],
	[undefined, false],
];

test("a right-to-left browser language is recognised, by its first subtag or its script", () => {
	for (const [language, expected] of LANGUAGES)
		assert.equal(direction.isRtlLanguage(language), expected, `${language}`);
});

test("Automatic follows the interface language and an explicit choice wins", () => {
	assert.equal(direction.resolveInterfaceDirection("auto", "ar"), "rtl");
	assert.equal(direction.resolveInterfaceDirection("auto", "nl"), "ltr");
	assert.equal(direction.resolveInterfaceDirection("auto", "en"), "ltr");
	assert.equal(direction.resolveInterfaceDirection("ltr", "ar"), "ltr");
	assert.equal(direction.resolveInterfaceDirection("rtl", "en"), "rtl");
	assert.equal(direction.parseInterfaceDirection("rtl"), "rtl");
	assert.equal(direction.parseInterfaceDirection("sideways"), "auto");
	assert.equal(direction.parseInterfaceDirection(null), "auto");
});

/** The bootstrap script as the browser runs it, in a sandbox. */
function runBootstrap({ saved, savedLanguage = null, language, storageThrows = false }) {
	const documentElement = { dir: "", lang: "" };
	const stored = {
		[direction.INTERFACE_DIRECTION_STORAGE_KEY]: saved,
		[languages.INTERFACE_LANGUAGE_STORAGE_KEY]: savedLanguage,
	};
	const sandbox = {
		document: { documentElement },
		navigator: { language },
		localStorage: {
			getItem: (key) => {
				if (storageThrows) throw new Error("blocked");
				return stored[key] ?? null;
			},
		},
	};
	vm.runInNewContext(direction.interfaceDirectionBootstrapScript, sandbox);
	return documentElement;
}

test("the bootstrap script agrees with the helpers it must stay in sync with", () => {
	for (const saved of [null, "auto", "ltr", "rtl", "sideways"])
		for (const savedLanguage of [null, "auto", "en", "nl", "ar", "klingon"])
			for (const [language] of [...LANGUAGES, ["nl-BE"], ["AR-eg"], ["fr_CA"]]) {
				const resolved = languages.resolveInterfaceLanguage(languages.parseInterfaceLanguage(savedLanguage), language);
				const expected = direction.resolveInterfaceDirection(direction.parseInterfaceDirection(saved), resolved);
				const root = runBootstrap({ saved, savedLanguage, language });
				assert.equal(root.dir, expected, `${saved} ${savedLanguage} ${language}`);
				assert.equal(root.lang, resolved, `${saved} ${savedLanguage} ${language}`);
			}
});

test("with storage blocked the bootstrap script still answers", () => {
	assert.equal(runBootstrap({ language: "ar", storageThrows: true }).dir, "rtl");
	assert.equal(runBootstrap({ language: "en", storageThrows: true }).dir, "ltr");
});

test("a right-to-left browser language Kite does not speak keeps English left to right", () => {
	const root = runBootstrap({ language: "he-IL" });
	assert.equal(root.lang, "en");
	assert.equal(root.dir, "ltr");
});

test("drags, swipes and arrow keys read along the document's direction", () => {
	assert.equal(direction.documentDirection(), "ltr", "no document: the server's answer");
	assert.equal(direction.toInlineDelta(10), 10);
	assert.equal(direction.logicalArrowKey("ArrowLeft"), "ArrowLeft");
	withDocumentDirection("ltr", () => {
		assert.equal(direction.toInlineDelta(10), 10);
		assert.equal(direction.logicalArrowKey("ArrowRight"), "ArrowRight");
	});
	withDocumentDirection("rtl", () => {
		assert.equal(direction.documentDirection(), "rtl");
		assert.equal(direction.toInlineDelta(10), -10);
		assert.equal(direction.toInlineDelta(-10), 10);
		assert.equal(direction.logicalArrowKey("ArrowLeft"), "ArrowRight");
		assert.equal(direction.logicalArrowKey("ArrowRight"), "ArrowLeft");
		assert.equal(direction.logicalArrowKey("ArrowDown"), "ArrowDown");
		assert.equal(direction.logicalArrowKey("Home"), "Home");
	});
});

test("isolation applies only in a right-to-left document", () => {
	assert.equal(isolateDirection("11:30 AM"), "11:30 AM");
	assert.equal(
		withDocumentDirection("ltr", () => isolateDirection("11:30 AM")),
		"11:30 AM",
	);
	assert.equal(
		withDocumentDirection("rtl", () => isolateDirection("11:30 AM")),
		"⁨11:30 AM⁩",
	);
});

test("a tooltip beside the rail opens away from the screen edge", () => {
	assert.equal(tooltipSide("right"), "right");
	assert.equal(tooltipSide("right", "rtl"), "left");
	assert.equal(tooltipSide("auto", "rtl"), "bottom");
});

test("the reading pane option names the side it opens on", () => {
	const label = (rtl) => readingPaneOptions(rtl).find((option) => option.value === "right").label;
	assert.equal(label(false), "Right of inbox");
	assert.equal(label(true), "Left of inbox");
	assert.equal(readingPaneOptions(true).length, readingPaneOptions(false).length);
});
