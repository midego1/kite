import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// From the inbound route's record to the alert the cron and the Admin banner report, over a real
// migrated database and an in-memory bucket.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-alerts-relay-");
after(() => rmSync(outDir, { recursive: true, force: true }));
const source = (path) => fileURLToPath(import.meta.resolve(`../src/${path}`));
await build({
	entryPoints: {
		snapshot: source("lib/alerts/snapshot.ts"),
		rules: source("lib/alerts/rules-utils.ts"),
		active: source("lib/alerts/active-utils.ts"),
		relaySignature: source("lib/alerts/relay-signature.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	sourcemap: "inline",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { collectAlertSnapshot } = await load("snapshot");
const { ALERT_POLICY, evaluateAlertRules } = await load("rules");
const { toActiveAlertView } = await load("active");
const { recordRelaySignatureProblem } = await load("relaySignature");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const MIN = 60_000;

async function setup(t) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, join(root, "drizzle/migrations"));
	const objects = new Map();
	const env = {
		DB: sqlite,
		BUCKET: {
			get: async (key) => (objects.has(key) ? { text: async () => objects.get(key) } : null),
			put: async (key, value) => objects.set(key, value),
		},
	};
	return { env, objects };
}

const rulesAt = async (env, now) => {
	const snapshot = await collectAlertSnapshot(env, now, 0, ALERT_POLICY);
	return { snapshot, alerts: evaluateAlertRules(snapshot, now, ALERT_POLICY) };
};

test("relay signature problems recorded by the inbound route reach the snapshot and the alert rules", async (t) => {
	const { env, objects } = await setup(t);
	const start = Date.UTC(2026, 9, 26, 10);
	const quiet = await rulesAt(env, new Date(start));
	assert.deepEqual(quiet.snapshot.relaySignature, {});
	assert.deepEqual(quiet.alerts, []);

	await recordRelaySignatureProblem(env, "missing", start);
	await recordRelaySignatureProblem(env, "legacy", start);
	const active = await rulesAt(env, new Date(start + 5 * MIN));
	assert.deepEqual(active.snapshot.relaySignature, { missingAt: start, legacyAt: start });
	assert.deepEqual(
		active.alerts.map((alert) => [alert.rule, alert.fingerprint]),
		[
			["relay_signature", "missing"],
			["relay_signature_legacy", "legacy"],
		],
	);
	const view = toActiveAlertView(active.alerts);
	assert.ok(view.some((alert) => /update the relay/.test(alert.name) && alert.href === "/admin"));
	assert.ok(view.some((alert) => /low priority/.test(alert.name)));

	// An hour later nothing new arrived, so the rules clear.
	assert.deepEqual((await rulesAt(env, new Date(start + 61 * MIN))).alerts, []);

	// A corrupt record never breaks the snapshot.
	objects.set("system/relay-signature.json", "{");
	assert.deepEqual((await rulesAt(env, new Date(start))).snapshot.relaySignature, {});
	env.BUCKET.get = async () => {
		throw new Error("bucket down");
	};
	assert.deepEqual((await rulesAt(env, new Date(start))).snapshot.relaySignature, {});
});
