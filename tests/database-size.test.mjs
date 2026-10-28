import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-database-size-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

async function load(entry, name) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(bundleDirectory, `${name}.mjs`),
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node24",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
	});
	return import(pathToFileURL(join(bundleDirectory, `${name}.mjs`)).href);
}

const size = await load("src/lib/db/size-utils.ts", "size");
const estimate = await load("src/lib/import/estimate-utils.ts", "estimate");
const guard = await load("src/lib/import/size-guard-utils.ts", "guard");
const rules = await load("src/lib/alerts/rules-utils.ts", "rules");

const GB = 1e9;

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { getDatabaseSize } from "./src/lib/db/size.ts";
		`,
		resolveDir: root,
		sourcefile: "database-size-entry.ts",
	},
	outfile: join(bundleDirectory, "runtime.mjs"),
	bundle: true,
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, getDatabaseSize } = await import(pathToFileURL(join(bundleDirectory, "runtime.mjs")).href);

test("the Node SQLite wrapper reports size_after, and getDatabaseSize has no limit there", async () => {
	const db = new SqliteDatabase(join(bundleDirectory, "size.sqlite"));
	await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
	const before = (await db.prepare("SELECT 1").run()).meta.size_after;
	assert.ok(before > 0);
	for (let index = 0; index < 50; index += 1) {
		await db.prepare("INSERT INTO t (body) VALUES (?)").bind("x".repeat(10_000)).run();
	}
	const after = (await db.prepare("SELECT 1").run()).meta.size_after;
	assert.ok(after > before + 400_000, `${before} -> ${after}`);
	const size = await getDatabaseSize({ DB: db, KITE_RUNTIME: "node" });
	assert.equal(size.limitBytes, null);
	assert.equal(size.usedBytes, after);
});

test("on D1 the limit is 10 GB unless D1_MAX_BYTES says otherwise, and an unknown size is null", async () => {
	const d1 = (sizeAfter) => ({ prepare: () => ({ run: async () => ({ meta: { size_after: sizeAfter } }) }) });
	assert.deepEqual(await getDatabaseSize({ DB: d1(123_456) }), { usedBytes: 123_456, limitBytes: 10 * GB });
	assert.deepEqual(await getDatabaseSize({ DB: d1(123_456), D1_MAX_BYTES: "500000000" }), {
		usedBytes: 123_456,
		limitBytes: 500_000_000,
	});
	assert.equal(await getDatabaseSize({ DB: d1(0) }), null);
	assert.equal(await getDatabaseSize({ DB: { prepare: () => ({ run: async () => ({}) }) } }), null);
	assert.equal(
		await getDatabaseSize({
			DB: {
				prepare: () => {
					throw new Error("down");
				},
			},
		}),
		null,
	);
	const injected = { usedBytes: 1, limitBytes: 2 };
	assert.equal(await getDatabaseSize({ DB: d1(5) }, injected), injected);
});

test("D1_MAX_BYTES overrides the 10 GB default only when it is a positive whole number", () => {
	assert.equal(size.d1MaxBytes(undefined), 10 * GB);
	assert.equal(size.d1MaxBytes("500000000"), 500_000_000);
	assert.equal(size.d1MaxBytes(" 500000000 "), 500_000_000);
	for (const bad of ["", "0", "-5", "ten", "1.5", "NaN"]) assert.equal(size.d1MaxBytes(bad), 10 * GB, bad);
});

test("levels switch at 70% and 90% of the limit, and never without a limit", () => {
	assert.equal(size.databaseUseLevel(6.99 * GB, 10 * GB), "ok");
	assert.equal(size.databaseUseLevel(7 * GB, 10 * GB), "warn");
	assert.equal(size.databaseUseLevel(8.99 * GB, 10 * GB), "warn");
	assert.equal(size.databaseUseLevel(9 * GB, 10 * GB), "critical");
	assert.equal(size.databaseUseLevel(50 * GB, null), "ok");
});

test("sizes read in decimal units, like Cloudflare's limits", () => {
	assert.equal(size.formatDatabaseBytes(1.9e9), "1.9 GB");
	assert.equal(size.formatDatabaseBytes(10e9), "10 GB");
	assert.equal(size.formatDatabaseBytes(640e6), "640 MB");
	assert.equal(size.formatDatabaseBytes(12_345), "12 KB");
	assert.equal(size.formatDatabaseBytes(12), "12 B");
});

test("the test size header is honoured outside production only", () => {
	const header = "used=8000000000;limit=10000000000";
	assert.deepEqual(size.parseTestDatabaseSize(header, "development"), { usedBytes: 8 * GB, limitBytes: 10 * GB });
	assert.deepEqual(size.parseTestDatabaseSize(header, undefined), { usedBytes: 8 * GB, limitBytes: 10 * GB });
	assert.equal(size.parseTestDatabaseSize(header, "production"), null);
	assert.equal(size.parseTestDatabaseSize(null, "development"), null);
	assert.equal(size.parseTestDatabaseSize("used=abc", "development"), null);
	assert.deepEqual(size.parseTestDatabaseSize("used=5;limit=none", "development"), { usedBytes: 5, limitBytes: null });
	assert.deepEqual(size.parseTestDatabaseSize("used=5", "development"), { usedBytes: 5, limitBytes: 10 * GB });
});

const base = { usedBytes: 3.1 * GB, limitBytes: 10 * GB, installMessageCount: 2000 };

test("the estimate uses the install's own average once it holds 1,000 messages", () => {
	// 3.1 GB / 2,000 messages = 1.55 MB, capped at 128 KB per message.
	const capped = estimate.estimateImport({ ...base, messages: 10_000, rawBytes: null });
	assert.equal(capped.databaseBytesPerMessage, 131_072);
	assert.equal(capped.databaseAddBytes, 10_000 * 131_072);
	const small = estimate.estimateImport({
		usedBytes: 100e6,
		limitBytes: 10 * GB,
		installMessageCount: 5000,
		messages: 1000,
		rawBytes: null,
	});
	assert.equal(small.databaseBytesPerMessage, 20_000);
	assert.equal(small.databaseAddBytes, 20e6);
});

test("a young install falls back to 40 KB per message", () => {
	const result = estimate.estimateImport({
		...base,
		installMessageCount: 999,
		usedBytes: 50e6,
		messages: 100,
		rawBytes: null,
	});
	assert.equal(result.databaseBytesPerMessage, 40_000);
	assert.equal(result.databaseAddBytes, 4e6);
});

test("a message cannot add more than it weighs, and offloaded bodies cap at 24 KB", () => {
	const light = estimate.estimateImport({ ...base, messages: 1000, rawBytes: 5_000_000 });
	assert.equal(light.databaseBytesPerMessage, 5000);
	assert.equal(light.databaseAddBytes, 5_000_000);
	const offloaded = estimate.estimateImport({ ...base, messages: 1000, rawBytes: null, bodyOffload: true });
	assert.equal(offloaded.databaseBytesPerMessage, 24_576);
});

test("the mail store holds 1.75 times the raw size", () => {
	const result = estimate.estimateImport({ ...base, messages: 48_000, rawBytes: 6.1 * GB });
	assert.equal(result.mailStoreBytes, Math.round(6.1 * GB * 1.75));
	assert.equal(estimate.estimateImport({ ...base, messages: 10, rawBytes: null }).mailStoreBytes, null);
});

test("an unknown message count adds nothing but still reports the current level", () => {
	const result = estimate.estimateImport({ ...base, usedBytes: 9.5 * GB, messages: null, rawBytes: null });
	assert.equal(result.databaseAddBytes, 0);
	assert.equal(result.currentLevel, "critical");
	assert.equal(result.requiresConfirmation, true);
	assert.equal(estimate.estimateImport({ ...base, messages: null, rawBytes: null }).requiresConfirmation, false);
});

test("thresholds apply to the projected size: warn at 70%, confirm above 90%", () => {
	const at = (usedBytes, messages) =>
		estimate.estimateImport({ usedBytes, limitBytes: 10 * GB, installMessageCount: 0, messages, rawBytes: null });
	assert.equal(at(6 * GB, 1000).projectedLevel, "ok");
	// 40 KB each: 30,000 messages add 1.2 GB.
	const warn = at(6 * GB, 30_000);
	assert.equal(warn.projectedLevel, "warn");
	assert.equal(warn.requiresConfirmation, false);
	const critical = at(8.5 * GB, 30_000);
	assert.equal(critical.projectedLevel, "critical");
	assert.equal(critical.requiresConfirmation, true);
	// No limit (Node): never a warning.
	const node = estimate.estimateImport({
		usedBytes: 50 * GB,
		limitBytes: null,
		installMessageCount: 0,
		messages: 1e6,
		rawBytes: null,
	});
	assert.equal(node.projectedLevel, "ok");
	assert.equal(node.requiresConfirmation, false);
});

test("the summary reads like the spec's example", () => {
	const result = estimate.estimateImport({
		usedBytes: 3.1 * GB,
		limitBytes: 10 * GB,
		installMessageCount: 0,
		messages: 48_000,
		rawBytes: 6.1 * GB,
	});
	const { summary } = estimate.describeImportEstimate(result, size.formatDatabaseBytes);
	assert.match(
		summary,
		/^About 48,000 messages, 6\.1 GB of mail\. Adds about 1\.9 GB to the database \(now 3\.1 GB of 10 GB\) and 10\.7 GB to mail storage\.$/,
	);
	const unknown = estimate.describeImportEstimate(
		estimate.estimateImport({ ...base, messages: null, rawBytes: null }),
		size.formatDatabaseBytes,
	);
	assert.equal(unknown.summary, "The database is now 3.1 GB of 10 GB.");
});

const NEARLY_FULL = /above 90% of its size limit/;
const FULL = /almost at its size limit/;

test("a running import pauses at 90% unless confirmed, and every import stops at 98%", () => {
	const at = (percent) => ({ usedBytes: percent * 1e8, limitBytes: 10 * GB });
	assert.equal(guard.importPauseNote(at(89), null), null);
	assert.match(guard.importPauseNote(at(90), null), NEARLY_FULL);
	assert.equal(guard.importPauseNote(at(95), guard.IMPORT_CONFIRMED_NOTE), null);
	assert.match(guard.importPauseNote(at(98), guard.IMPORT_CONFIRMED_NOTE), FULL);
	assert.match(guard.importPauseNote(at(99), null), FULL);
	// Unknown size and no limit never pause.
	assert.equal(guard.importPauseNote(null, null), null);
	assert.equal(guard.importPauseNote({ usedBytes: 1e12, limitBytes: null }, null), null);
});

test("only the confirmation note is carried to the next run", () => {
	assert.equal(guard.carriedImportNote(guard.IMPORT_CONFIRMED_NOTE), guard.IMPORT_CONFIRMED_NOTE);
	assert.equal(guard.carriedImportNote("IMAP timed out"), null);
	assert.equal(guard.carriedImportNote(null), null);
});

test("starting or resuming needs confirmation from 90%", () => {
	assert.equal(guard.needsStartConfirmation({ usedBytes: 8.9 * GB, limitBytes: 10 * GB }), false);
	assert.equal(guard.needsStartConfirmation({ usedBytes: 9 * GB, limitBytes: 10 * GB }), true);
	assert.equal(guard.needsStartConfirmation(null), false);
});

test("the database alert fires from 90% and names the percentage", () => {
	const snapshot = {
		failedBackups: [],
		outboundFailed: 0,
		outboundStuck: 0,
		webhookExhausted: 0,
		webhookLastAttemptAt: null,
		relaySignature: {},
	};
	const now = new Date("2026-01-01T12:00:00Z");
	assert.deepEqual(rules.evaluateAlertRules({ ...snapshot, databaseUsedPercent: 89.9 }, now), []);
	assert.deepEqual(rules.evaluateAlertRules({ ...snapshot, databaseUsedPercent: null }, now), []);
	assert.deepEqual(rules.evaluateAlertRules({ ...snapshot, databaseUsedPercent: 93.4 }, now), [
		{ rule: "database_nearly_full", fingerprint: "active", count: 93 },
	]);
});
