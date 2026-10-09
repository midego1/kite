import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-admin-route-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/admin-route-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { requiresPrimaryAdmin } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("owner-only admin routes and their children require the primary admin", () => {
	for (const path of [
		"/agent",
		"/api-keys",
		"/webhooks",
		"/backups",
		"/branding",
		"/activity",
		"/audit-logs",
		"/general",
		"/ai-usage",
		"/alerts",
		"/webhooks/abc",
		"/alerts/x",
	])
		assert.equal(requiresPrimaryAdmin(path), true, path);
});

test("routes any admin may open do not require the primary admin", () => {
	for (const path of ["/admin", "/mailboxes", "/mailboxes/mbx_1", "/domains", "/routing", "/accounts", "/accounts/u1"])
		assert.equal(requiresPrimaryAdmin(path), false, path);
});

test("a prefix only matches whole path segments", () => {
	for (const path of ["/agents", "/backupsx", "/generalized", "/alertsx", "/settings/api-keys"])
		assert.equal(requiresPrimaryAdmin(path), false, path);
});
