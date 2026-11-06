import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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

// Its own bundle, where esbuild keeps the function names the coverage gate merges records by.
const { createTranslator } = await load("src/lib/i18n/translator-utils.ts", "translator");

// One bundle for the rest: each copy of a source file counts as another, half-run record in the coverage gate.
const outfile = join(outDir, "i18n.mjs");
await build({
	stdin: {
		contents: `export * from "./src/lib/i18n/message-format-utils.ts";
			export * as languages from "./src/lib/i18n/language-utils.ts";
			export { createLanguageLoader } from "./src/lib/i18n/language-loader.ts";
			export { currentLocale, englishTranslator, setTranslator, t } from "./src/lib/i18n/translator.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	absWorkingDir: root,
	outfile,
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const {
	createLanguageLoader,
	currentLocale,
	describeMessage,
	englishTranslator,
	formatMessage,
	languages,
	setTranslator,
	t,
} = await import(pathToFileURL(outfile).href);

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

/**
 * Every literal key passed to `t()`, `translate()` (an effect's `t`) or `msg()`, calls the check could not read and casts
 * to `MessageKey`. A key held in a table is written with `msg()`; the type of `t` makes that the only way in, so an
 * expression here or a cast elsewhere is the only way around the check.
 */
function scanSource() {
	const keys = new Map();
	const unreadable = [];
	const casts = [];
	for (const file of sourceFiles(join(root, "src"))) {
		const text = readFileSync(file, "utf8");
		if (!text.includes("@/lib/i18n/")) continue;
		if (/\bas (?:unknown as )?MessageKey\b/.test(text) && !file.includes(`src${sep}lib${sep}i18n${sep}`))
			casts.push(relative(root, file));
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
		const visit = (node) => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
				const name = node.expression.text;
				const [key] = node.arguments;
				if ((name === "t" || name === "translate" || name === "msg") && key) {
					if (ts.isStringLiteralLike(key)) keys.set(key.text, relative(root, file));
					else if (name === "msg" || !isTableKey(key)) unreadable.push(`${relative(root, file)}: ${key.getText()}`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return { keys, unreadable, casts };
}

/** A name or a table entry, which can only be a `MessageKey`; anything else may hide a string the check cannot read. */
function isTableKey(node) {
	return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

const { keys, unreadable, casts } = scanSource();

/** How many type errors a snippet using `t` has, against the real types. */
function typeErrors(lines) {
	const file = join(root, "src/lib/i18n/key-gate.ts");
	const text = `import type { MessageKey, Translate } from "./i18n-types";
declare const t: Translate;
declare const plain: string;
declare const key: MessageKey;
declare const table: { label: string };
declare const marked: { label: MessageKey };
${lines}`;
	const options = {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		types: [],
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
	};
	const host = ts.createCompilerHost(options);
	const { fileExists, getSourceFile, readFile } = host;
	host.fileExists = (name) => name === file || fileExists(name);
	host.readFile = (name) => (name === file ? text : readFile(name));
	host.getSourceFile = (name, ...rest) =>
		name === file ? ts.createSourceFile(name, text, ts.ScriptTarget.ESNext) : getSourceFile(name, ...rest);
	const program = ts.createProgram([file], options, host);
	return program.getSemanticDiagnostics(program.getSourceFile(file)).length;
}

/** A loader with fresh state, on a page that shows English. */
function freshLoader() {
	setTranslator(englishTranslator());
	globalThis.document = { documentElement: { lang: "" } };
	return createLanguageLoader();
}

function deferred() {
	let resolve, reject;
	const promise = new Promise((done, fail) => ((resolve = done), (reject = fail)));
	return { promise, resolve, reject };
}

const DUTCH = { Inbox: "Dutch inbox" };
const ARABIC = { Inbox: "Arabic inbox" };

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

test("Automatic takes Dutch from the browser; Arabic, still a draft, only by choice", () => {
	for (const [preference, browser, expected] of [
		["auto", "nl-BE", "nl"],
		["auto", "NL", "nl"],
		["auto", "nl_NL", "nl"],
		["auto", "ar", "en"],
		["auto", "AR-eg", "en"],
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

test("a browser tag Intl refuses is normalised, or falls back to the plain language", () => {
	assert.equal(languages.interfaceLocale("nl", "nl_NL"), "nl-NL");
	assert.equal(languages.interfaceLocale("nl", "nl_be"), "nl-BE");
	assert.equal(languages.interfaceLocale("nl", "nl-!!"), "nl");
	assert.doesNotThrow(() => createTranslator("nl", languages.interfaceLocale("nl", "nl_NL"), {}));
});

test("the script's language expression answers like pageLanguage", () => {
	const page = new Function(
		"saved",
		"browser",
		"pathname",
		`return ${languages.languageBootstrapExpression("saved", "browser", "pathname")};`,
	);
	for (const saved of [null, "auto", "en", "nl", "ar", "klingon"])
		for (const browser of ["nl-BE", "NL", "nl_NL", "ar-EG", "en-GB", "he", ""])
			for (const pathname of ["/inbox", "/login", "/book/ada", "/"])
				assert.equal(
					page(saved, browser, pathname),
					languages.pageLanguage(languages.parseInterfaceLanguage(saved), browser, pathname),
					`${saved} ${browser} ${pathname}`,
				);
});

test("only the choices Kite knows count as a language setting", () => {
	assert.equal(languages.isInterfaceLanguageChoice("auto"), true);
	assert.equal(languages.isInterfaceLanguageChoice("ar"), true);
	assert.equal(languages.isInterfaceLanguageChoice("klingon"), false);
	assert.equal(languages.isInterfaceLanguageChoice(7), false);
	assert.equal(languages.isInterfaceLanguageChoice(null), false);
});

test("public pages stay English whatever the setting says; signed-in pages follow it", () => {
	for (const path of [
		"/",
		"/login",
		"/register",
		"/setup",
		"/onboarding",
		"/forgot-password",
		"/reset-password",
		"/book/ada",
		"/book/ada/intro",
		"/c/ada",
		"/d/token",
	]) {
		assert.equal(languages.isUntranslatedPage(path), true, path);
		assert.equal(languages.pageLanguage("ar", "ar", path), "en", path);
	}
	for (const path of ["/inbox", "/inbox/msg_1", "/settings", "/drive", "/calendar", "/books", "/data", "/compose"]) {
		assert.equal(languages.isUntranslatedPage(path), false, path);
		assert.equal(languages.pageLanguage("ar", "en", path), "ar", path);
	}
});

test("a catalog that fails leaves English, never a stuck mailbox, and the next try works", async () => {
	const loader = freshLoader();
	let notified = 0;
	loader.subscribe(() => (notified += 1));
	const loading = deferred();
	const applied = loader.apply("nl", "en", "/inbox", () => loading.promise);
	assert.equal(loader.isReady(), false, "the mailbox waits for the first catalog");
	assert.equal(document.documentElement.lang, "nl");
	loading.reject(new Error("chunk gone"));
	await applied;
	assert.equal(loader.isReady(), true);
	assert.equal(notified, 2);
	assert.equal(t("Inbox"), "Inbox");

	await loader.apply("nl", "en", "/inbox", async () => DUTCH);
	assert.equal(t("Inbox"), "Dutch inbox");
});

test("a loader or a browser tag that throws cannot hold the mailbox back", async () => {
	const throwing = freshLoader();
	await throwing.apply("nl", "en", "/inbox", () => {
		throw new Error("no chunk");
	});
	assert.equal(throwing.isReady(), true);

	const badTag = freshLoader();
	await badTag.apply("auto", "nl_NL", "/inbox", async () => DUTCH);
	assert.equal(badTag.isReady(), true);
	assert.equal(t("Inbox"), "Dutch inbox");
	assert.equal(currentLocale(), "nl-NL");
});

test("the last choice wins when catalogs arrive out of order", async () => {
	const loader = freshLoader();
	const dutch = deferred();
	const arabic = deferred();
	const first = loader.apply("nl", "en", "/inbox", () => dutch.promise);
	const second = loader.apply("ar", "en", "/inbox", () => arabic.promise);
	arabic.resolve(ARABIC);
	await second;
	assert.equal(t("Inbox"), "Arabic inbox");
	assert.equal(loader.isReady(), false, "the first load has not settled");
	dutch.resolve(DUTCH);
	await first;
	assert.equal(t("Inbox"), "Arabic inbox");
	assert.equal(loader.isReady(), true);

	const late = deferred();
	const pending = loader.apply("nl", "en", "/inbox", () => late.promise);
	await loader.apply("en", "en", "/inbox");
	late.resolve(DUTCH);
	await pending;
	assert.equal(t("Inbox"), "Inbox");
	assert.equal(document.documentElement.lang, "en");
});

test("a later switch never takes the page down, and a public page loads nothing", async () => {
	const loader = freshLoader();
	await loader.apply("en", "en", "/inbox");
	const later = deferred();
	const pending = loader.apply("nl", "en", "/inbox", () => later.promise);
	assert.equal(loader.isReady(), true);
	later.resolve(DUTCH);
	await pending;

	const load = () => assert.fail("a public page fetched a catalog");
	await loader.apply("ar", "ar", "/login", load);
	assert.equal(document.documentElement.lang, "en");
	assert.equal(t("Inbox"), "Inbox");

	const signedIn = deferred();
	const arriving = loader.apply("ar", "ar", "/inbox", () => signedIn.promise);
	assert.equal(loader.isReady(), false, "arriving from a public page is a first load");
	signedIn.resolve(ARABIC);
	await arriving;
	assert.equal(loader.isReady(), true);
	assert.equal(t("Inbox"), "Arabic inbox");
});

test("t takes a literal or a msg() key; a plain string does not compile", () => {
	assert.equal(typeErrors(`t("Literal"); t("{n} new", { n: 1 }); t(key); t(marked.label);`), 0);
	assert.equal(typeErrors("t(plain);"), 1);
	assert.equal(typeErrors("t(table.label);"), 1);
	assert.equal(typeErrors("t(`Template ${plain}`);"), 1);
});

test("every call is one the catalog check can read, and nothing casts around it", () => {
	assert.deepEqual(unreadable, []);
	assert.deepEqual(casts, []);
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
