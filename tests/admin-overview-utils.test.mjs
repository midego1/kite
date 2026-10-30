import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-admin-overview-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/app/(admin)/admin/overview-utils.ts")],
	outfile: join(bundleDirectory, "overview-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
	tsconfig: join(root, "tsconfig.json"),
});
const RECENT_AI_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;
const { attentionItems, overviewStats } = await import(pathToFileURL(join(bundleDirectory, "overview-utils.mjs")).href);

const NOW = Date.parse("2026-10-30T12:00:00Z");
const quiet = {
	accounts: [{ role: "admin" }, { role: "user" }, { role: "user", disabled: true }],
	mailboxes: [{ type: "personal" }, { type: "shared" }],
	domains: [{ status: "active" }],
	migrations: { pending: 0 },
	databaseSize: { size: { usedBytes: 1_200_000, limitBytes: 10_000_000_000 }, level: "ok" },
	backups: {
		level: "ok",
		lastSuccess: { id: "b", completedAt: "2026-10-30T02:00:00Z" },
		lastFailure: null,
		inProgress: false,
		automatic: { enabled: true },
		restore: null,
	},
	webhooks: [{ enabled: true, stats: { failing: 0 } }],
	aiErrors: [],
};

test("a quiet install needs no attention and shows its counts", () => {
	assert.deepEqual(attentionItems(quiet, true, NOW), []);
	assert.deepEqual(
		overviewStats(quiet, "2026.10.30.1").map((stat) => [stat.id, stat.value, stat.hint, stat.href]),
		[
			["accounts", "3", "1 admin · 1 disabled", "/accounts"],
			["mailboxes", "2", "1 shared inbox", "/mailboxes"],
			["domains", "1", "All active", "/domains"],
			["database", "1.2 MB", "0% of 10 GB", "#database"],
		],
	);
});

test("errors come before warnings and information, each with where to go", () => {
	const data = {
		...quiet,
		migrations: { pending: 2 },
		domains: [{ status: "active" }, { status: "pending" }, { status: "pending", dnsSkipped: true }],
		databaseSize: { size: { usedBytes: 9_500_000_000, limitBytes: 10_000_000_000 }, level: "critical" },
		backups: { ...quiet.backups, lastFailure: { id: "x", failedAt: "2026-10-30T02:00:00Z", error: "R2 timeout" } },
		webhooks: [
			{ enabled: true, stats: { failing: 2 } },
			{ enabled: false, stats: { failing: 9 } },
		],
		aiErrors: [
			{ at: new Date(NOW - 60_000).toISOString() },
			{ at: new Date(NOW - RECENT_AI_ERROR_WINDOW_MS - 1).toISOString() },
		],
	};
	const items = attentionItems(data, true, NOW);
	assert.deepEqual(
		items.map((item) => [item.id, item.tone]),
		[
			["backup-failed", "error"],
			["database-size", "error"],
			["migrations", "warning"],
			["webhooks", "warning"],
			["ai-errors", "warning"],
			["domains", "info"],
		],
	);
	const byId = Object.fromEntries(items.map((item) => [item.id, item]));
	assert.equal(byId.migrations.title, "2 database updates waiting");
	assert.equal(byId.migrations.href, "#database");
	assert.equal(byId["backup-failed"].detail, "R2 timeout");
	assert.equal(byId["database-size"].title, "The database is at 95% of its size limit");
	assert.equal(byId.webhooks.title, "1 webhook with failed deliveries");
	assert.equal(byId.webhooks.detail, "2 deliveries could not be made.");
	assert.equal(byId["ai-errors"].title, "1 AI request failed in the last 24 hours");
	assert.equal(byId.domains.title, "1 domain not active yet", "a domain with DNS skipped is not nagged about");
	assert.equal(overviewStats(data, "x").find((stat) => stat.id === "database").tone, "critical");
	assert.equal(overviewStats(data, "x").find((stat) => stat.id === "domains").hint, "1 of 3 active");
});

test("a restore that needs recovery and a missing first backup are reported", () => {
	const recovery = { ...quiet, backups: { ...quiet.backups, restore: { needsRecovery: true } } };
	assert.deepEqual(
		attentionItems(recovery, true, NOW).map((item) => [item.id, item.tone, item.href]),
		[["restore", "error", "#backups"]],
	);
	const none = { ...quiet, backups: { ...quiet.backups, lastSuccess: null } };
	assert.deepEqual(
		attentionItems(none, true, NOW).map((item) => [item.id, item.tone]),
		[["backup-none", "warning"]],
	);
	assert.deepEqual(attentionItems({ ...none, backups: { ...none.backups, inProgress: true } }, true, NOW), []);
});

test("a non-primary admin sees only what they may read, and is told who applies updates", () => {
	const data = {
		...quiet,
		migrations: { pending: 1 },
		databaseSize: null,
		backups: null,
		webhooks: null,
		aiErrors: null,
	};
	const items = attentionItems(data, false, NOW);
	assert.deepEqual(
		items.map((item) => [item.id, item.hrefLabel]),
		[["migrations", ""]],
	);
	assert.match(items[0].detail, /Only the primary admin/);
	assert.deepEqual(
		overviewStats(data, "x").map((stat) => stat.id),
		["accounts", "mailboxes", "domains"],
	);
});
