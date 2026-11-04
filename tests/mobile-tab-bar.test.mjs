import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-mobile-tab-bar-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/mobile-tab-bar-utils.ts")],
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	packages: "external",
	logLevel: "silent",
});
const { mobilePrimaryTabIds, mobileActiveTabId, hidesMobileTabBar } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

const ALL_MODULES = ["calendar", "booking", "templates", "import", "finance", "drive"];

test("the tab bar is Mail, then the modules that are on, then More", () => {
	assert.deepEqual(mobilePrimaryTabIds(ALL_MODULES, false), ["mail", "calendar", "drive", "finance"]);
	assert.deepEqual(mobilePrimaryTabIds(["calendar"], false), ["mail", "calendar", "starred", "sent"]);
	assert.deepEqual(mobilePrimaryTabIds(["drive", "finance"], false), ["mail", "drive", "finance", "starred"]);
	assert.deepEqual(mobilePrimaryTabIds([], false), ["mail", "starred", "sent", "drafts"]);
});

test("For you fills a free slot but never pushes a module tab off the bar", () => {
	assert.deepEqual(mobilePrimaryTabIds([], true), ["mail", "for-you", "starred", "sent"]);
	assert.deepEqual(mobilePrimaryTabIds(["calendar", "drive"], true), ["mail", "calendar", "drive", "for-you"]);
	assert.deepEqual(mobilePrimaryTabIds(ALL_MODULES, true), ["mail", "calendar", "drive", "finance"]);
});

test("a specific tab wins over the Mail umbrella, and only one tab is current", () => {
	const all = ["mail", "calendar", "drive", "finance"];
	assert.equal(mobileActiveTabId(all, "/inbox"), "mail");
	assert.equal(mobileActiveTabId(all, "/inbox/message-1"), "mail");
	assert.equal(mobileActiveTabId(all, "/folders/folder-1"), "mail");
	assert.equal(mobileActiveTabId(all, "/screener"), "mail");
	assert.equal(mobileActiveTabId(all, "/for-you"), "mail");
	assert.equal(mobileActiveTabId(all, "/calendar"), "calendar");
	assert.equal(mobileActiveTabId(all, "/booking"), "calendar");
	assert.equal(mobileActiveTabId(all, "/drive/f/folder-1"), "drive");
	assert.equal(mobileActiveTabId(all, "/finance"), "finance");
	assert.equal(mobileActiveTabId(all, "/settings/account"), null);
	assert.equal(mobileActiveTabId(all, "/admin"), null);

	const withStarred = ["mail", "starred", "sent", "drafts"];
	assert.equal(mobileActiveTabId(withStarred, "/starred"), "starred");
	assert.equal(mobileActiveTabId(all, "/starred"), "mail");
	assert.equal(mobileActiveTabId(withStarred, "/for-you"), "mail");
});

test("the reader and Compose hide the bar; folder and module pages keep it", () => {
	assert.equal(hidesMobileTabBar("/inbox"), false);
	assert.equal(hidesMobileTabBar("/inbox/message-1"), true);
	assert.equal(hidesMobileTabBar("/starred/message-1"), true);
	assert.equal(hidesMobileTabBar("/folders/folder-1"), false);
	assert.equal(hidesMobileTabBar("/folders/folder-1/message-1"), true);
	assert.equal(hidesMobileTabBar("/compose"), true);
	assert.equal(hidesMobileTabBar("/calendar"), false);
	assert.equal(hidesMobileTabBar("/drive"), false);
	assert.equal(hidesMobileTabBar("/finance"), false);
});

test("a message route keeps the bar while the list is still beside the reader, Compose never does", () => {
	assert.equal(hidesMobileTabBar("/inbox/message-1", true), false);
	assert.equal(hidesMobileTabBar("/starred/message-1", true), false);
	assert.equal(hidesMobileTabBar("/folders/folder-1/message-1", true), false);
	assert.equal(hidesMobileTabBar("/compose", true), true);
	assert.equal(hidesMobileTabBar("/inbox/message-1", false), true);
});
