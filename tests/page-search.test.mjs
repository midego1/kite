import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-page-search-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/mail-search/page-search-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { flattenPageResults, moveHighlight, pageSearchPlaceholder, resultToOpen, searchPages } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

const base = { isPrimaryAdmin: false, canManageDomains: false, canManageUsers: false };
const primary = { ...base, role: "admin", isPrimaryAdmin: true };
const admin = { ...base, role: "admin" };
const member = { ...base, role: "user" };

const labels = (groups) => flattenPageResults(groups).map((result) => `${result.mode}:${result.label}`);

test("the placeholder follows the menu mode", () => {
	assert.equal(pageSearchPlaceholder("settings"), "Search settings");
	assert.equal(pageSearchPlaceholder("admin"), "Search admin");
});

test("a blank query lists nothing", () => {
	assert.deepEqual(searchPages("", primary, "settings"), []);
	assert.deepEqual(searchPages("   ", primary, "admin"), []);
});

test("results come from both menus, the current one first, labelled by menu", () => {
	assert.deepEqual(labels(searchPages("domains", primary, "settings")), ["admin:Domains"]);
	assert.deepEqual(labels(searchPages("appearance", primary, "admin")), ["settings:Appearance"]);
	assert.deepEqual(labels(searchPages("members", primary, "settings")), ["admin:Accounts"]);
	assert.deepEqual(labels(searchPages("audit", primary, "admin")), ["admin:Activity"]);

	const groups = searchPages("a", primary, "settings");
	assert.deepEqual(
		groups.map((group) => group.mode),
		["settings", "admin"],
	);
	const domains = flattenPageResults(searchPages("domains", primary, "settings"))[0];
	assert.equal(domains.href, "/domains");
	assert.equal(domains.section, "Email");
	assert.ok(domains.icon);
});

test("each result has a unique id in list order", () => {
	const ids = flattenPageResults(searchPages("a", primary, "settings")).map((result) => result.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.deepEqual(
		ids,
		ids.map((_, index) => `page-search-option-${index}`),
	);
});

test("results keep the menu permission rules", () => {
	assert.deepEqual(labels(searchPages("domains", member, "settings")), []);
	assert.ok(labels(searchPages("a", member, "settings")).every((label) => label.startsWith("settings:")));
	for (const query of ["backups", "branding", "webhooks", "audit"])
		assert.deepEqual(labels(searchPages(query, admin, "admin")), [], query);
	assert.deepEqual(labels(searchPages("members", admin, "settings")), ["admin:Accounts"]);
	assert.deepEqual(labels(searchPages("zzzz", primary, "settings")), []);
});

test("arrow keys walk the list and wrap at both ends", () => {
	assert.equal(moveHighlight(-1, 3, "down"), 0);
	assert.equal(moveHighlight(0, 3, "down"), 1);
	assert.equal(moveHighlight(2, 3, "down"), 0);
	assert.equal(moveHighlight(-1, 3, "up"), 2);
	assert.equal(moveHighlight(2, 3, "up"), 1);
	assert.equal(moveHighlight(0, 3, "up"), 2);
	assert.equal(moveHighlight(5, 3, "down"), 0);
	assert.equal(moveHighlight(5, 3, "up"), 2);
	assert.equal(moveHighlight(-1, 0, "down"), -1);
	assert.equal(moveHighlight(0, 0, "up"), -1);
});

test("Enter opens the highlighted result, else the first, else nothing", () => {
	const results = flattenPageResults(searchPages("a", primary, "settings"));
	assert.equal(resultToOpen(results, 2), results[2]);
	assert.equal(resultToOpen(results, -1), results[0]);
	assert.equal(resultToOpen([], -1), undefined);
});
