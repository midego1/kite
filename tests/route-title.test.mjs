import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-route-title-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/route-title-utils.ts")],
	outfile: join(bundleDirectory, "route-title.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { formatRouteTitle, getRouteTitle } = await import(pathToFileURL(join(bundleDirectory, "route-title.mjs")).href);

test("pages are titled after the most specific matching route", () => {
	assert.equal(getRouteTitle("/settings"), "Settings");
	assert.equal(getRouteTitle("/settings/security"), "Security");
	assert.equal(getRouteTitle("/settings/api-keys"), "API keys");
	assert.equal(getRouteTitle("/api-keys"), "API keys");
	assert.equal(getRouteTitle("/accounts/abc/permissions"), "Accounts");
	assert.equal(getRouteTitle("/agent"), "Agent");
	assert.equal(getRouteTitle("/agent/review/apr_1"), "AI draft review");
	assert.equal(getRouteTitle("/calendar"), "Calendar");
});

test("mail folders, messages and look-alike paths are left to their own title", () => {
	for (const path of [
		"/inbox",
		"/inbox/msg_1",
		"/sent",
		"/folders/f1",
		"/folders/f1/msg_1",
		"/login",
		"/domainsx",
		"/",
	])
		assert.equal(getRouteTitle(path), null, path);
});

test("the title names the page before the app", () => {
	assert.equal(formatRouteTitle("Domains", "Acme Mail"), "Domains - Acme Mail");
});
