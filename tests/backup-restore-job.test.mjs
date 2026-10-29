import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-backup-restore-job-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/backups/restore-job-utils.ts")],
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

const NOW = Date.UTC(2026, 9, 29, 12);
const minutes = (count) => new Date(NOW - count * 60_000).toISOString();
const job = (overrides) => ({
	id: "rst_1",
	status: "restoring",
	seq: 3,
	lease: null,
	userId: "owner",
	createdAt: minutes(30),
	updatedAt: minutes(0),
	finishedAt: null,
	source: { key: "backups/uploads/rst_1.json", upload: true, filename: null },
	kept: [],
	plan: null,
	safety: { id: "bak_safety", trigger: "pre-restore", r2Key: "backups/database/bak_safety/x.json", filename: "x.json" },
	rollbackPlan: null,
	cursor: null,
	interruptions: 0,
	rowCount: 10,
	error: null,
	changed: true,
	needsRecovery: false,
	...overrides,
});

test("restore messages are recognised by kind, id and step", () => {
	const message = lib.restoreJobMessage("rst_1", 4);
	assert.deepEqual(message, { kind: "backup.restore", restoreId: "rst_1", seq: 4 });
	assert.equal(lib.isRestoreJobMessage(message), true);
	assert.equal(lib.isRestoreJobMessage({ kind: "backup.restore", restoreId: "rst_1" }), false);
	assert.equal(lib.isRestoreJobMessage({ kind: "backup.run", backupId: "bak_1" }), false);
	assert.equal(lib.isRestoreJobMessage(null), false);
	assert.equal(lib.isRestoreJobMessage("backup.restore"), false);
});

test("steps that read a whole file hold the long lease, writing steps the short one", () => {
	const long = lib.restoreLeaseMs(job({ status: "validating" }));
	assert.equal(lib.restoreLeaseMs(job({ status: "snapshot" })), long);
	assert.equal(lib.restoreLeaseMs(job({ status: "rolling_back" })), long, "planning the rollback reads the snapshot");
	const short = lib.restoreLeaseMs(job({ status: "restoring" }));
	assert.equal(lib.restoreLeaseMs(job({ status: "rolling_back", rollbackPlan: { tables: [] } })), short);
	assert.ok(short < long && short > lib.RESTORE_CHUNK_MS, "a chunk always finishes inside its lease");
});

test("the cron resends a stalled job, waits while a lease runs and gives up after an hour", () => {
	const at = (overrides) => lib.restoreMaintenanceAction(job(overrides), NOW);
	assert.equal(at({ status: "completed", updatedAt: minutes(600) }), "none");
	assert.equal(at({ updatedAt: minutes(1) }), "none", "its message may still be on its way");
	assert.equal(at({ updatedAt: minutes(3) }), "resend");
	assert.equal(at({ updatedAt: minutes(3), lease: { id: "l", until: NOW + 60_000 } }), "none");
	assert.equal(at({ updatedAt: minutes(3), lease: { id: "l", until: NOW - 1 } }), "resend");
	assert.equal(at({ updatedAt: minutes(61), lease: { id: "l", until: NOW + 60_000 } }), "abandon");
});

test("a phase interrupted too often rolls back, gives up, or fails without changes", () => {
	assert.equal(lib.interruptedRestorePatch(job({ interruptions: 3 })), null);
	assert.deepEqual(lib.interruptedRestorePatch(job({ interruptions: 4 })), {
		status: "rolling_back",
		error: "The restore was interrupted repeatedly before it finished",
		cursor: null,
		interruptions: 0,
	});
	const rollback = lib.interruptedRestorePatch(
		job({ status: "rolling_back", interruptions: 4, error: "batch failed" }),
	);
	assert.equal(rollback.status, "failed");
	assert.equal(rollback.needsRecovery, true);
	assert.equal(rollback.error, "batch failed, and the automatic rollback was interrupted repeatedly");
	assert.match(
		lib.interruptedRestorePatch(job({ status: "rolling_back", interruptions: 4 })).error,
		/^The restore failed, and/,
	);
	const validating = lib.interruptedRestorePatch(job({ status: "validating", interruptions: 4 }));
	assert.equal(validating.status, "failed");
	assert.equal(validating.needsRecovery, undefined);
});

test("the summary shows a running restore, a recent one and one that needs recovery", () => {
	assert.equal(lib.summarizeRestoreJob(null, NOW), null);
	const running = lib.summarizeRestoreJob(job({}), NOW);
	assert.equal(running.active, true);
	assert.deepEqual(running.safetyBackup, { id: "bak_safety", filename: "x.json" });
	assert.equal(lib.summarizeRestoreJob(job({ safety: null }), NOW).safetyBackup, null);

	const finished = (hoursAgo, overrides) =>
		lib.summarizeRestoreJob(job({ status: "completed", finishedAt: minutes(hoursAgo * 60), ...overrides }), NOW);
	assert.equal(finished(2).active, false);
	assert.equal(finished(25), null, "a day later it is gone");
	assert.equal(finished(25, { status: "failed", needsRecovery: true }).needsRecovery, true, "until it is resolved");
	assert.equal(lib.summarizeRestoreJob(job({ status: "failed", finishedAt: null }), NOW), null);
});

test("the outcome of a finished restore in words", () => {
	assert.equal(lib.restoreOutcomeText({ status: "completed", error: null, needsRecovery: false }), null);
	assert.equal(lib.restoreOutcomeText({ status: "restoring", error: null, needsRecovery: false }), null);
	assert.equal(
		lib.restoreOutcomeText({ status: "rolled_back", error: "batch failed", needsRecovery: false }),
		"The restore failed and the previous data was put back: batch failed",
	);
	assert.equal(
		lib.restoreOutcomeText({ status: "failed", error: null, needsRecovery: false }),
		"The restore failed and nothing was changed.",
	);
	assert.equal(
		lib.restoreOutcomeText({ status: "failed", error: "interrupted", needsRecovery: true }),
		"The restore failed and could not be rolled back: interrupted",
	);
});
