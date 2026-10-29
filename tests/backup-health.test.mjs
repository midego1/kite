import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-backup-health-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/backups/health-utils.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const lib = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const at = (minutes) => new Date(Date.UTC(2026, 9, 29, 2, minutes));
const row = (overrides) => ({
	id: "bak_1",
	status: "completed",
	trigger: "scheduled",
	size: 2048,
	error: null,
	createdAt: at(0),
	startedAt: at(1),
	completedAt: at(3),
	...overrides,
});
const automatic = { enabled: true, scheduleType: "daily", retentionEnabled: true, retentionDays: 14 };

test("the last successful backup carries its size and duration", () => {
	const success = row({});
	const health = lib.summarizeBackupHealth({
		lastCompleted: success,
		lastFinished: success,
		inProgress: false,
		automatic,
	});
	assert.equal(health.level, "ok");
	assert.deepEqual(health.lastSuccess, {
		id: "bak_1",
		trigger: "scheduled",
		completedAt: at(3).toISOString(),
		size: 2048,
		durationMs: 120_000,
	});
	assert.equal(health.lastFailure, null);
	assert.deepEqual(health.automatic, automatic);
});

test("a failed latest run warns, and a later success clears it", () => {
	const success = row({});
	const failed = row({ id: "bak_2", status: "failed", error: "R2 went away", size: null, completedAt: at(10) });
	const health = lib.summarizeBackupHealth({
		lastCompleted: success,
		lastFinished: failed,
		inProgress: true,
		automatic,
	});
	assert.equal(health.level, "failed");
	assert.deepEqual(health.lastFailure, {
		id: "bak_2",
		trigger: "scheduled",
		failedAt: at(10).toISOString(),
		error: "R2 went away",
	});
	assert.equal(health.lastSuccess.id, "bak_1");
	assert.equal(health.inProgress, true);

	const later = row({ id: "bak_3", completedAt: at(20) });
	assert.equal(
		lib.summarizeBackupHealth({ lastCompleted: later, lastFinished: later, inProgress: false, automatic }).level,
		"ok",
	);
});

test("no backup at all, and rows without a start time", () => {
	assert.equal(
		lib.summarizeBackupHealth({ lastCompleted: null, lastFinished: null, inProgress: false, automatic: null }).level,
		"none",
	);
	const unstarted = row({ startedAt: null });
	const health = lib.summarizeBackupHealth({
		lastCompleted: unstarted,
		lastFinished: unstarted,
		inProgress: false,
		automatic,
	});
	assert.equal(health.lastSuccess.durationMs, null);
});

test("durations read naturally", () => {
	assert.equal(lib.formatBackupDuration(850), "850 ms");
	assert.equal(lib.formatBackupDuration(12_400), "12 s");
	assert.equal(lib.formatBackupDuration(185_000), "3 min 5 s");
	assert.equal(lib.formatBackupDuration(120_000), "2 min");
	assert.equal(lib.formatBackupDuration(3_720_000), "1 h 2 min");
	assert.equal(lib.formatBackupDuration(7_200_000), "2 h");
});
