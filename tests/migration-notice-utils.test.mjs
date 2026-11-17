import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-migration-notice-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [
		join(root, "src/components/migration-notice-utils.ts"),
		join(root, "src/components/migration-progress-utils.ts"),
	],
	outdir: bundleDirectory,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { migrationDetailLabels, migrationNoticePhase, migrationNoticeState, migrationProgressPercent } = await import(
	pathToFileURL(join(bundleDirectory, "migration-notice-utils.mjs")).href
);
const { migrationProgressView } = await import(
	pathToFileURL(join(bundleDirectory, "migration-progress-utils.mjs")).href
);

test("a run in progress wins over an old error; an error shows only once nothing runs", () => {
	assert.equal(migrationNoticeState({ busy: false, error: null }), "pending");
	assert.equal(migrationNoticeState({ busy: true, error: null }), "applying");
	assert.equal(migrationNoticeState({ busy: true, error: "failed" }), "applying");
	assert.equal(migrationNoticeState({ busy: false, error: "failed" }), "failed");
});

test("the phase is the backup until the first update lands, and another tab's run only says it goes on", () => {
	const names = ["0001_a.sql", "0002_b.sql", "0003_c.sql"];
	assert.equal(migrationNoticePhase(migrationProgressView(names, null), true), "backup");
	assert.equal(migrationNoticePhase(migrationProgressView(names, names), true), "backup");
	assert.equal(migrationNoticePhase(migrationProgressView(names, names.slice(1)), true), "applying");
	// A dropped connection keeps the count; the hint line says it is being checked.
	assert.equal(migrationNoticePhase(migrationProgressView(names, names.slice(1), true), true), "applying");
	assert.equal(migrationNoticePhase(migrationProgressView([], null), false), "elsewhere");
});

test("the bar is indeterminate until something is done, then follows the count", () => {
	assert.equal(migrationProgressPercent(0, 4), null);
	assert.equal(migrationProgressPercent(2, 0), null);
	assert.equal(migrationProgressPercent(1, 4), 25);
	assert.equal(migrationProgressPercent(4, 4), 100);
	assert.equal(migrationProgressPercent(9, 4), 100);
});

test("the details list updates in words, once each, without file names", () => {
	assert.deepEqual(migrationDetailLabels(undefined), []);
	assert.deepEqual(
		migrationDetailLabels(["0106_add_mcp_oauth_clients.sql", "0107_add_mcp_oauth_clients.sql", "0108_add_index.sql"]),
		["Add MCP oauth clients", "Add index"],
	);
});
