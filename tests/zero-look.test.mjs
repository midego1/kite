import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-zero-look-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: [
			'export * from "./src/components/messages/message-list-chips-utils.ts";',
			'export * from "./src/components/messages/message-list-sections-utils.ts";',
			'export { getThreadParticipants, getThreadDateRange } from "./src/components/messages/conversation-thread-utils.ts";',
			'export * from "./src/components/theme-utils.ts";',
		].join("\n"),
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const helpers = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("a category chip adds its search term once and takes it out again, keeping the typed query", () => {
	assert.equal(helpers.toggleSearchTerm("", "has:attachment"), "has:attachment");
	assert.equal(helpers.toggleSearchTerm("from:maya", "is:starred"), "from:maya is:starred");
	assert.equal(helpers.toggleSearchTerm("from:maya  is:starred", "is:starred"), "from:maya");
	assert.equal(helpers.hasSearchTerm("invoice HAS:ATTACHMENT", "has:attachment"), true);
	assert.equal(helpers.hasSearchTerm("has:attachments", "has:attachment"), false);
	assert.equal(helpers.withoutChipTerms("invoice has:attachment is:starred"), "invoice");
});

test("the Inbox groups starred mail under Pinned and the rest under Primary, in list order", () => {
	const messages = [
		{ id: "a", starred: false },
		{ id: "b", starred: true },
		{ id: "c", starred: false },
		{ id: "d", starred: true },
	];
	const sections = helpers.groupListSections(messages, true);
	assert.deepEqual(
		sections.map((section) => [section.key, section.label, section.messages.map((message) => message.id)]),
		[
			["pinned", "Pinned", ["b", "d"]],
			["primary", "Primary", ["a", "c"]],
		],
	);
	assert.deepEqual(
		sections.map((section) => section.count),
		[2, null],
	);
	assert.deepEqual(
		helpers.groupListSections([{ id: "a", starred: false }], true).map((section) => section.key),
		["primary"],
	);
	const flat = helpers.groupListSections(messages, false);
	assert.equal(flat.length, 1);
	assert.equal(flat[0].label, null);
	assert.deepEqual(
		flat[0].messages.map((message) => message.id),
		["a", "b", "c", "d"],
	);
});

test("thread participants are listed once each by address, in order", () => {
	assert.deepEqual(
		helpers.getThreadParticipants([
			{ name: "Sofia", address: "sofia@northwind.test" },
			{ name: "Daniel", address: "daniel@northwind.test" },
			{ name: "Sofia Marchetti", address: "SOFIA@northwind.test" },
			{ name: " ", address: "team@northwind.test" },
			{ name: "", address: "" },
		]),
		[
			{ name: "Sofia", address: "sofia@northwind.test" },
			{ name: "Daniel", address: "daniel@northwind.test" },
			{ name: "team@northwind.test", address: "team@northwind.test" },
		],
	);
});

test("the thread date range runs from the first to the last valid date", () => {
	assert.deepEqual(
		helpers.getThreadDateRange(["2026-03-29T10:00:00Z", "not a date", "2026-03-25T10:15:00Z", "2026-03-27T08:00:00Z"]),
		{ first: "2026-03-25T10:15:00Z", last: "2026-03-29T10:00:00Z" },
	);
	assert.equal(helpers.getThreadDateRange([]), null);
});

test("Kite is dark-first with the neutral style by default; Kite classic is a style of its own", () => {
	assert.equal(helpers.DEFAULT_THEME, "dark");
	assert.equal(helpers.DEFAULT_STYLE, "kite");
	for (const style of ["kite", "lavender", "classic"]) assert.equal(helpers.isStylePreference(style), true);
	assert.equal(helpers.isStylePreference("zero"), false);
	assert.match(helpers.themeBootstrapScript, /: "dark"/);
	assert.match(helpers.themeBootstrapScript, /"lavender"/);
});
