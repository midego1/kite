import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-i18n-test-");
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

const { describeMessage, formatMessage } = await load("src/lib/i18n/message-format-utils.ts", "format");
const { createTranslator } = await load("src/lib/i18n/translator-utils.ts", "translator");
const languages = await load("src/lib/i18n/language-utils.ts", "languages");

const CATALOGS = Object.fromEntries(
	["nl", "ar"].map((language) => [
		language,
		JSON.parse(readFileSync(join(root, "src/locales", `${language}.json`), "utf8")),
	]),
);

const sourceFiles = (dir) =>
	readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
		.map((entry) => join(entry.parentPath, entry.name));

/** Every literal key passed to `t()`, `translate()` (an effect's `t`) or `msg()`, and calls the check could not read. */
function scanSource() {
	const keys = new Map();
	const unreadable = [];
	for (const file of sourceFiles(join(root, "src"))) {
		const text = readFileSync(file, "utf8");
		if (!text.includes("@/lib/i18n/")) continue;
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
		const visit = (node) => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
				const name = node.expression.text;
				const [key] = node.arguments;
				if ((name === "t" || name === "translate" || name === "msg") && key) {
					if (ts.isStringLiteralLike(key)) keys.set(key.text, relative(root, file));
					else if (name === "msg" || ts.isTemplateExpression(key))
						unreadable.push(`${relative(root, file)}: ${key.getText()}`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return { keys, unreadable };
}

const { keys, unreadable } = scanSource();

const formats = (language) => ({
	plural: new Intl.PluralRules(language),
	number: new Intl.NumberFormat(language),
});

test("a message fills in values, formatted numbers and plural forms", () => {
	const en = formats("en");
	assert.equal(formatMessage("Hello {name}", { name: "Ada" }, en), "Hello Ada");
	assert.equal(formatMessage("{count} unread", { count: 1234 }, en), "1,234 unread");
	const files = "{count, plural, =0 {No files} one {# file} other {# files}}";
	assert.equal(formatMessage(files, { count: 0 }, en), "No files");
	assert.equal(formatMessage(files, { count: 1 }, en), "1 file");
	assert.equal(formatMessage(files, { count: 2500 }, en), "2,500 files");
	const nested = "{count, plural, one {# of {total}} other {# of {total}}} done";
	assert.equal(formatMessage(nested, { count: 2, total: "five" }, en), "2 of five done");
});

test("the plural forms and numbers follow the language", () => {
	const ar = formats("ar");
	const message = "{count, plural, zero {صفر} one {واحد} two {اثنان} few {# قليل} many {# كثير} other {# غير ذلك}}";
	assert.equal(formatMessage(message, { count: 1 }, ar), "واحد");
	assert.equal(formatMessage(message, { count: 2 }, ar), "اثنان");
	assert.match(formatMessage(message, { count: 5 }, ar), /قليل$/);
	assert.match(formatMessage(message, { count: 11 }, ar), /كثير$/);
	assert.equal(formatMessage("{n}", { n: 1234.5 }, formats("nl")), "1.234,5");
});

test("a malformed message or a missing value shows as written instead of breaking the page", () => {
	const en = formats("en");
	assert.equal(formatMessage("Broken {count", { count: 1 }, en), "Broken {count");
	assert.equal(formatMessage("{a, plural, one {x}}", { a: 1 }, en), "{a, plural, one {x}}", "no other form");
	assert.equal(formatMessage("Hello {name}", {}, en), "Hello {name}");
	assert.equal(describeMessage("Broken {count"), null);
});

test("a key the catalog lacks falls back to English, and context prefixes never show", () => {
	const { t } = createTranslator("nl", "nl", { Inbox: "Postvak", "folder|Archive": "Archief" });
	assert.equal(t("Inbox"), "Postvak");
	assert.equal(t("folder|Archive"), "Archief");
	assert.equal(t("Missing"), "Missing");
	assert.equal(t("menu|Missing"), "Missing");
	assert.equal(t("{count} new", { count: 1000 }), "1.000 new");
	assert.equal(createTranslator("en", undefined, {}).t("folder|Archive"), "Archive");
});

test("Automatic takes the browser language when Kite speaks it, English otherwise", () => {
	for (const [preference, browser, expected] of [
		["auto", "nl-BE", "nl"],
		["auto", "AR-eg", "ar"],
		["auto", "nl_NL", "nl"],
		["auto", "en-GB", "en"],
		["auto", "he-IL", "en"],
		["auto", "", "en"],
		["auto", null, "en"],
		["en", "ar", "en"],
		["ar", "en-US", "ar"],
	])
		assert.equal(languages.resolveInterfaceLanguage(preference, browser), expected, `${preference} ${browser}`);
	assert.equal(languages.parseInterfaceLanguage("nl"), "nl");
	assert.equal(languages.parseInterfaceLanguage("klingon"), "auto");
	assert.equal(languages.parseInterfaceLanguage(null), "auto");
});

test("dates keep the browser's locale in English and its region within a translation", () => {
	assert.equal(languages.interfaceLocale("en", "nl-NL"), undefined);
	assert.equal(languages.interfaceLocale("nl", "nl-BE"), "nl-BE");
	assert.equal(languages.interfaceLocale("nl", "en-US"), "nl");
	assert.equal(languages.interfaceLocale("ar", "ar-AE"), "ar-AE");
});

test("every call is one the catalog check can read", () => {
	assert.deepEqual(unreadable, []);
	for (const key of keys.keys()) assert.ok(describeMessage(key), `malformed source string: ${key}`);
});

for (const [language, catalog] of Object.entries(CATALOGS)) {
	const required = new Intl.PluralRules(language).resolvedOptions().pluralCategories;

	test(`${language}: the catalog has exactly the keys the code uses`, () => {
		const missing = [...keys.keys()].filter((key) => !catalog[key]?.trim());
		const extra = Object.keys(catalog).filter((key) => !keys.has(key));
		assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
	});

	test(`${language}: placeholders match the source and every plural form is there`, () => {
		for (const [key, translation] of Object.entries(catalog)) {
			const source = describeMessage(key);
			const target = describeMessage(translation);
			assert.ok(target, `malformed translation of ${key}`);
			assert.deepEqual(target.names, source.names, `placeholders of ${key}`);
			if (!source.categories.length) continue;
			const named = target.categories.filter((category) => !category.startsWith("="));
			for (const category of required) assert.ok(named.includes(category), `${key} lacks "${category}"`);
		}
	});
}

test("the language list and the catalogs agree", () => {
	const values = languages.INTERFACE_LANGUAGES.map((language) => language.value);
	assert.deepEqual(values, ["en", ...Object.keys(CATALOGS)]);
});
