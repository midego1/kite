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
const { attentionItems, overviewStats } = await import(pathToFileURL(join(bundleDirectory, "overview-utils.mjs")).href);

const quiet = {
	migrations: { pending: 0 },
	counts: {
		accounts: { total: 3, admins: 1, disabled: 1 },
		mailboxes: { total: 2, shared: 1 },
		domains: { total: 1, active: 1, inactive: 0 },
		webhooks: { failingHooks: 0, recentFailures: 0 },
		aiErrors: { recent: 0, capped: false },
	},
	databaseSize: { size: { usedBytes: 1_200_000, limitBytes: 10_000_000_000 }, level: "ok" },
	backups: {
		level: "ok",
		lastSuccess: { id: "b", completedAt: "2026-10-30T02:00:00Z" },
		lastFailure: null,
		inProgress: false,
		automatic: { enabled: true },
		restore: null,
	},
};

test("a quiet install needs no attention and shows its counts", () => {
	assert.deepEqual(attentionItems(quiet, true), []);
	assert.deepEqual(
		overviewStats(quiet).map((stat) => [stat.id, stat.value, stat.hint, stat.href]),
		[
			["accounts", "3", "1 admin · 1 disabled", "/accounts"],
			["mailboxes", "2", "1 shared inbox", "/mailboxes"],
			["domains", "1", "All active", "/domains"],
			["database", "1.2 MB", "0% of 10 GB", "#database-size"],
		],
	);
	const unlimited = { ...quiet, databaseSize: { size: { usedBytes: 500, limitBytes: null }, level: "ok" } };
	assert.equal(overviewStats(unlimited).at(-1).hint, "No size limit on this server");
});

test("errors come before warnings and information, each with where to go", () => {
	const data = {
		...quiet,
		migrations: { pending: 2 },
		counts: {
			...quiet.counts,
			domains: { total: 3, active: 1, inactive: 2 },
			webhooks: { failingHooks: 1, recentFailures: 2 },
			aiErrors: { recent: 1, capped: false },
		},
		databaseSize: { size: { usedBytes: 9_500_000_000, limitBytes: 10_000_000_000 }, level: "critical" },
		backups: { ...quiet.backups, lastFailure: { id: "x", failedAt: "2026-10-30T02:00:00Z", error: "R2 timeout" } },
	};
	const items = attentionItems(data, true);
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
	assert.equal(byId["database-size"].href, "#database-size");
	assert.equal(byId.webhooks.title, "1 webhook with failed deliveries");
	assert.equal(byId.webhooks.detail, "2 deliveries could not be made in the last 24 hours.");
	assert.equal(byId["ai-errors"].title, "1 AI request failed in the last 24 hours");
	// Only the AI failures offer Why?.
	assert.deepEqual(
		items.filter((item) => item.why).map((item) => item.id),
		["ai-errors"],
	);
	assert.equal(byId.domains.title, "2 domains not active yet");
	assert.equal(overviewStats(data).find((stat) => stat.id === "database").tone, "critical");
	assert.equal(overviewStats(data).find((stat) => stat.id === "domains").hint, "1 of 3 active");
});

test("a full AI error list reads as a lower bound", () => {
	const data = { ...quiet, counts: { ...quiet.counts, aiErrors: { recent: 200, capped: true } } };
	assert.equal(attentionItems(data, true)[0].title, "200+ AI requests failed in the last 24 hours");
});

test("a restore that needs recovery and a missing first backup are reported", () => {
	const recovery = { ...quiet, backups: { ...quiet.backups, restore: { needsRecovery: true } } };
	assert.deepEqual(
		attentionItems(recovery, true).map((item) => [item.id, item.tone, item.href]),
		[["restore", "error", "#backups"]],
	);
	const none = { ...quiet, backups: { ...quiet.backups, lastSuccess: null } };
	assert.deepEqual(
		attentionItems(none, true).map((item) => [item.id, item.tone]),
		[["backup-none", "warning"]],
	);
	assert.deepEqual(attentionItems({ ...none, backups: { ...none.backups, inProgress: true } }, true), []);
});

test("a non-primary admin sees only what they may read; pending updates come from the notice instead", () => {
	const data = {
		migrations: { pending: 1 },
		counts: { ...quiet.counts, domains: null, webhooks: null, aiErrors: null },
		databaseSize: null,
		backups: null,
	};
	assert.deepEqual(attentionItems(data, false), []);
	assert.deepEqual(
		overviewStats(data).map((stat) => stat.id),
		["accounts", "mailboxes"],
	);
	const withDomains = { ...data, counts: { ...data.counts, domains: { total: 2, active: 1, inactive: 1 } } };
	assert.deepEqual(
		attentionItems(withDomains, false).map((item) => item.id),
		["domains"],
	);
	assert.ok(overviewStats(withDomains).some((stat) => stat.id === "domains"));
});

test("nothing loaded yet means nothing to show, not zeros", () => {
	assert.deepEqual(overviewStats({ migrations: null, counts: null, databaseSize: null, backups: null }), []);
	assert.deepEqual(attentionItems({ migrations: null, counts: null, databaseSize: null, backups: null }, true), []);
});

test("direct uploads off is a dismissible item for the primary admin, a warning when the automatic setup failed", () => {
	const off = { ...quiet, directUploads: { show: true, setup: null } };
	const [item] = attentionItems(off, true);
	assert.deepEqual(
		[item.id, item.tone, item.title, item.href, item.hrefLabel, item.dismissible],
		["direct-uploads", "info", "Direct uploads are off: set up (2 min)", "/storage?setup=direct", "Set up", true],
	);
	assert.match(item.detail, /straight to R2/);
	const failed = {
		...quiet,
		directUploads: {
			show: true,
			setup: {
				ok: false,
				source: "install",
				message: "CF_TOKEN may not do this.",
				permission: "Account API Tokens: Edit",
			},
		},
	};
	const [warning] = attentionItems(failed, true);
	assert.equal(warning.tone, "warning");
	assert.equal(
		warning.detail,
		'The automatic setup during installation did not finish: CF_TOKEN may not do this. CF_TOKEN needs "Account API Tokens: Edit".',
	);
	assert.deepEqual(attentionItems(off, false), [], "only the primary admin");
	assert.deepEqual(
		attentionItems({ ...quiet, directUploads: { show: false, setup: null } }, true),
		[],
		"on or dismissed",
	);
	const ranked = attentionItems({ ...failed, migrations: { pending: 1 } }, true).map((entry) => entry.id);
	assert.deepEqual(ranked, ["migrations", "direct-uploads"], "after the more urgent warnings");
});
