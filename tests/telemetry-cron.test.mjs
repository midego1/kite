import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

/**
 * Nothing is sent without a decision. An install whose owner never chose (setup not finished, or an upgrade whose
 * owner was not told yet) makes no outside request from either 02:00 cron path, the Worker's `scheduled` handler
 * and the Node scheduler, and once the notice was shown none before its start day. Both run with the global `fetch`
 * replaced by a recorder.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-telemetry-cron-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		worker: join(root, "worker.ts"),
		scheduler: join(root, "server/runtime/scheduler.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		state: join(root, "src/lib/telemetry/state.ts"),
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
	define: { "process.env.NEXT_PUBLIC_KITE_BUILD_VERSION": JSON.stringify("2026.10.26.0") },
	plugins: [
		{
			// The app's request handler and the realtime Durable Object are not part of a cron run; the env comes from
			// getNodeEnv(), as in the Node build.
			name: "stub-worker-runtime",
			setup(builder) {
				builder.onResolve({ filter: /^vinext\/server\/fetch-handler$|^cloudflare:workers$/ }, ({ path }) => ({
					path,
					namespace: "stub",
				}));
				builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
					contents:
						path === "cloudflare:workers"
							? "export const env = undefined; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
							: "export default { fetch() { throw new Error('not in a cron run'); } };",
					loader: "js",
				}));
			},
		},
	],
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { default: worker } = await load("worker");
const { startScheduler } = await load("scheduler");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");
const { markTelemetryNotice, readTelemetryState, recordSetupTelemetryChoice, setTelemetryEnabled } =
	await load("state");

const UNDECIDED = {
	available: true,
	noticeAvailable: true,
	enabled: false,
	decision: null,
	installId: null,
	lastSentDay: null,
	startDay: null,
	noticeDismissed: false,
};
const AT_TWO = Date.parse("2026-10-27T02:00:00Z");
const DAY_MS = 86_400_000;
const NEXT_DAY = AT_TWO + 86_400_000;
const HEARTBEAT = "https://kite-telemetry.midego.net/v1/heartbeat";
const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
	requests.push(String(input instanceof Request ? input.url : input));
	throw new Error("no outside request expected");
};
const previousNodeEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.fetch = originalFetch;
	globalThis.__kiteNodeEnv = previousNodeEnv;
});

async function defaultInstall(t, extra = {}) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, join(root, "drizzle/migrations"));
	const objects = new Map();
	const env = {
		DB: sqlite,
		BUCKET: {
			put: async (key, value) => void objects.set(key, value),
			get: async () => null,
			head: async () => null,
			delete: async () => undefined,
			list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
		},
		...extra,
	};
	globalThis.__kiteNodeEnv = env;
	assert.deepEqual(await readTelemetryState(env), UNDECIDED, "no saved choice");
	return env;
}

/** Lets every pending promise and I/O callback of a cron run finish. */
async function settle() {
	for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function runWorkerCron(env, scheduledTime) {
	const pending = [];
	const ctx = { waitUntil: (promise) => pending.push(Promise.resolve(promise).catch(() => undefined)) };
	await worker.scheduled({ cron: "0 2 * * *", scheduledTime }, env, ctx);
	await Promise.all(pending);
	await settle();
	assert.ok(pending.length > 0, "the cron did run its tasks");
}

function runNodeScheduler(env, now) {
	mock.timers.enable({ apis: ["setInterval", "Date"], now });
	let stop;
	try {
		stop = startScheduler(env);
		mock.timers.tick(60_000);
	} finally {
		stop?.();
		mock.timers.reset();
	}
	return settle();
}

test("the Worker's 02:00 cron sends nothing for a default install", async (t) => {
	const env = await defaultInstall(t);
	requests.length = 0;
	await runWorkerCron(env, AT_TWO);
	assert.deepEqual(requests, []);
	// The same run once the owner opted in does reach the collector, so the recorder would have seen a request.
	await setTelemetryEnabled(env, true);
	await runWorkerCron(env, NEXT_DAY);
	assert.deepEqual(requests, [HEARTBEAT]);
});

test("the Node scheduler's 02:00 run sends nothing for a default install", async (t) => {
	const env = await defaultInstall(t, { KITE_RUNTIME: "node" });
	requests.length = 0;
	await runNodeScheduler(env, AT_TWO + 30_000);
	assert.deepEqual(requests, []);
	assert.deepEqual(await readTelemetryState(env), UNDECIDED);
	await setTelemetryEnabled(env, true);
	await runNodeScheduler(env, NEXT_DAY + 30_000);
	assert.deepEqual(requests, [HEARTBEAT], "the same run once opted in");
});

test("after the notice, neither cron path sends before the start day, and both do on it", async (t) => {
	for (const [name, run, extra] of [
		["Worker", (env, time) => runWorkerCron(env, time), {}],
		["Node", (env, time) => runNodeScheduler(env, time + 30_000), { KITE_RUNTIME: "node" }],
	]) {
		const env = await defaultInstall(t, extra);
		requests.length = 0;
		// Seen on 26 October at 15:00 UTC: sending may start on 10 November.
		await markTelemetryNotice(env, "shown", new Date(AT_TWO - 11 * 3_600_000));
		assert.equal((await readTelemetryState(env)).startDay, "2026-11-10", name);
		for (let time = AT_TWO; time < Date.parse("2026-11-10T02:00:00Z"); time += DAY_MS) await run(env, time);
		assert.deepEqual(requests, [], `${name}: nothing during the 14 days`);
		assert.equal((await readTelemetryState(env)).installId, null, `${name}: no id during the 14 days`);
		await run(env, Date.parse("2026-11-10T02:00:00Z"));
		assert.deepEqual(requests, [HEARTBEAT], `${name}: the start day's run reports`);
	}
});

test("a setup finished with the switch off never reports from either cron path", async (t) => {
	for (const extra of [{}, { KITE_RUNTIME: "node" }]) {
		const env = await defaultInstall(t, extra);
		requests.length = 0;
		await recordSetupTelemetryChoice(env, false);
		for (let day = 0; day < 30; day += 1)
			if (extra.KITE_RUNTIME) await runNodeScheduler(env, AT_TWO + day * DAY_MS + 30_000);
			else await runWorkerCron(env, AT_TWO + day * DAY_MS);
		assert.deepEqual(requests, []);
		assert.deepEqual(await readTelemetryState(env), { ...UNDECIDED, decision: "off" });
	}
});
