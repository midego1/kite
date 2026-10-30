import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-migration-progress-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/migration-progress-utils.ts")],
	outfile: join(bundleDirectory, "progress.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
});
const {
	MIGRATION_OUTCOME_UNKNOWN,
	formatElapsed,
	migrationApplyFailure,
	migrationDoneSummary,
	migrationProgressView,
	migrationRecoveredSummary,
} = await import(pathToFileURL(join(bundleDirectory, "progress.mjs")).href);

const NAMES = ["0081_a.sql", "0082_b.sql", "0083_c.sql", "0084_d.sql"];

test("elapsed time reads in seconds, then minutes", () => {
	assert.equal(formatElapsed(0), "0 s");
	assert.equal(formatElapsed(12.9), "12 s");
	assert.equal(formatElapsed(59), "59 s");
	assert.equal(formatElapsed(65), "1 min 05 s");
	assert.equal(formatElapsed(-3), "0 s");
});

test("the safety backup is the active step until the first update has landed", () => {
	const view = migrationProgressView(NAMES, null);
	assert.deepEqual(
		view.steps.map((step) => [step.id, step.state]),
		[
			["backup", "active"],
			["apply", "waiting"],
		],
	);
	assert.equal(view.steps[0].label, "Saving a safety backup, then applying…");
	assert.match(view.steps[1].label, /^Applying 4 updates \(0081_a\.sql, 0082_b\.sql, 0083_c\.sql and 1 more\)$/);
	assert.equal(view.announcement, "Saving a safety backup, then applying.");
	assert.equal(view.done, 0);
});

test("updates leaving the pending list count as done", () => {
	const view = migrationProgressView(NAMES, NAMES.slice(2));
	assert.deepEqual(
		view.steps.map((step) => step.state),
		["done", "active"],
	);
	assert.equal(view.steps[1].label, "Applying 4 updates: 2 of 4 done…");
	assert.equal(view.done, 2);
	assert.equal(view.total, 4);
	assert.equal(view.announcement, "Applying 4 updates, 2 of 4 done.");
});

test("a pending list with names from elsewhere, or a single update, is counted sensibly", () => {
	assert.equal(migrationProgressView(["0081_a.sql"], ["0099_other.sql"]).done, 1);
	assert.equal(migrationProgressView(["0081_a.sql"], null).steps[1].label, "Applying 1 update (0081_a.sql)");
	const unknownTotal = migrationProgressView([], null);
	assert.equal(unknownTotal.total, 0);
	assert.equal(unknownTotal.steps[1].label, "Applying the updates");
});

test("the finished message lists what was applied, the backup and the time taken", () => {
	assert.equal(
		migrationDoneSummary({ applied: NAMES, backupId: "bak_1" }, 12.4),
		"4 database updates applied. A safety backup was saved first. Took 12 s.",
	);
	assert.equal(migrationDoneSummary({ applied: ["0081_a.sql"], backupId: null }, 0.2), "1 database update applied.");
});

test("a restore in progress, an unreachable server and a failed update each read clearly", () => {
	assert.match(migrationApplyFailure(409, "A backup restore is running."), /not changed: a backup restore is running/);

	const failed = migrationApplyFailure(
		500,
		"Migration 0082_b.sql failed: boom. A backup taken just before is listed on the Backups page.",
	);
	assert.match(failed, /^The database update failed\. Migration 0082_b\.sql failed: boom\./);
	assert.match(failed, /A backup taken just before is listed on the Backups page\./);
	assert.match(failed, /Updates that already finished stay applied\.$/);

	assert.match(migrationApplyFailure(500, undefined), /^The database update failed\. The server answered 500\./);
	assert.doesNotMatch(
		migrationApplyFailure(500, "Could not back up the database before migrating, so nothing was changed: x"),
		/stay applied/,
	);
});

test("a dropped connection keeps the steps and says the update may still be running", () => {
	const view = migrationProgressView(NAMES, NAMES.slice(1), true);
	assert.equal(view.notice, "The connection timed out; the update may still be running — checking…");
	assert.match(view.announcement, /1 of 4 done\. The connection timed out/);
	assert.equal(migrationProgressView(NAMES, null).notice, null);
});

test("a run that was recovered after a dropped connection does not claim the safety backup", () => {
	assert.equal(
		migrationRecoveredSummary(NAMES, 125),
		"4 database updates applied. Took 2 min 05 s. The connection dropped meanwhile, so check the Backups page for the safety backup.",
	);
	assert.match(MIGRATION_OUTCOME_UNKNOWN, /not known whether the database update finished/);
});
