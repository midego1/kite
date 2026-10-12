import assert from "node:assert/strict";
import test from "node:test";
import { backupRunMessage, isBackupRunMessage } from "../src/lib/backups/queue-utils.ts";
import { STALE_BACKUP_AFTER_MS, STALE_BACKUP_ERROR, isStaleBackup } from "../src/lib/backups/utils.ts";

const now = new Date("2026-10-12T12:00:00.000Z");
const ago = (ms) => new Date(now.getTime() - ms);

test("a queued or running backup is stale once its progress is older than the threshold", () => {
	assert.equal(
		isStaleBackup({ status: "running", startedAt: ago(STALE_BACKUP_AFTER_MS + 1000), createdAt: now }, now),
		true,
	);
	assert.equal(
		isStaleBackup({ status: "queued", startedAt: null, createdAt: ago(STALE_BACKUP_AFTER_MS + 1000) }, now),
		true,
	);
});

test("a backup that is still within the threshold, or already finished, is not stale", () => {
	// Exactly at the threshold still counts as running, so a long export is never cut off mid-write.
	assert.equal(isStaleBackup({ status: "running", startedAt: ago(STALE_BACKUP_AFTER_MS), createdAt: now }, now), false);
	assert.equal(
		isStaleBackup({ status: "running", startedAt: ago(STALE_BACKUP_AFTER_MS - 1000), createdAt: now }, now),
		false,
	);
	assert.equal(
		isStaleBackup({ status: "queued", startedAt: null, createdAt: ago(STALE_BACKUP_AFTER_MS - 1000) }, now),
		false,
	);
	for (const status of ["completed", "failed"]) {
		assert.equal(isStaleBackup({ status, startedAt: ago(86_400_000), createdAt: ago(86_400_000) }, now), false);
	}
});

test("the start time wins over the creation time, and a row without either is left alone", () => {
	// A backup created long ago but started a minute ago is making progress.
	assert.equal(isStaleBackup({ status: "running", startedAt: ago(60_000), createdAt: ago(86_400_000) }, now), false);
	// A row created long ago that was never picked up is the interrupted case.
	assert.equal(isStaleBackup({ status: "queued", startedAt: null, createdAt: ago(86_400_000) }, now), true);
	assert.equal(isStaleBackup({ status: "running", startedAt: null, createdAt: null }, now), false);
});

test("the recorded reason explains the interruption to an admin", () => {
	assert.equal(STALE_BACKUP_ERROR, "Backup was interrupted before it finished");
});

test("the queue body for a manual backup is recognised by its kind and id", () => {
	const message = backupRunMessage("bak_1");
	assert.deepEqual(message, { kind: "backup.run", backupId: "bak_1" });
	assert.equal(isBackupRunMessage(message), true);
	for (const value of [
		null,
		undefined,
		"backup.run",
		1,
		{},
		{ kind: "backup.run" },
		{ kind: "backup.run", backupId: 7 },
		{ kind: "backup.other", backupId: "bak_1" },
		{ kind: "email.scheduled", backupId: "bak_1" },
		{ kind: "constructor", backupId: "bak_1" },
	])
		assert.equal(isBackupRunMessage(value), false);
});
