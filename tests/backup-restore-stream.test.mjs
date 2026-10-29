import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-backup-restore-stream-test-");
const bucketRoot = mkdtempSync(join(tmpdir(), "kite-restore-bucket-"));
after(() => {
	rmSync(directory, { recursive: true, force: true });
	rmSync(bucketRoot, { recursive: true, force: true });
});

/** The migration status check reads the generated bundle; these tests run on a fully migrated database. */
const migrationStatusStub = {
	name: "migration-status-stub",
	setup(builder) {
		builder.onResolve({ filter: /^@\/lib\/migrations\/service$/ }, () => ({
			path: "migration-status-stub",
			namespace: "stub",
		}));
		builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: "export async function getMigrationStatus() { return { pending: [], unknown: [] }; }",
			loader: "js",
		}));
	},
};

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { FileBucket } from "./server/runtime/file-bucket.ts";
			export * from "./src/lib/backups/backup-reader-utils.ts";
			export { bucketBackupSource } from "./src/lib/backups/backup-reader.ts";
			export { RestoreBatchWriter } from "./src/lib/backups/restore-writer.ts";
			export { exportDatabaseRecords, prepareDatabaseRestore, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
			export { executeDatabaseRestore } from "./src/lib/backups/restore-engine.ts";
			export { RestoreBusyError, RestoreRecoveryPendingError, startSafetyRecovery, startStoredRestore, startUploadedRestore } from "./src/lib/backups/restore.ts";
			export { processRestoreMessage, runRestoreMaintenance } from "./src/lib/backups/restore-job.ts";
			export { readRestoreJob, writeRestoreJob } from "./src/lib/backups/restore-job-store.ts";
			export { restoreRowError } from "./src/lib/backups/restore-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "backup-restore-stream-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	plugins: [migrationStatusStub],
	logLevel: "silent",
});
const lib = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Feeds bytes to a scanner in pages of `size`, returning every event with rows parsed. */
function scan(bytes, size, mode = "document") {
	const scanner = new lib.BackupDocumentScanner(mode);
	const events = [];
	for (let offset = 0; offset < bytes.byteLength; offset += size)
		for (const event of scanner.push(bytes.subarray(offset, offset + size)))
			events.push("raw" in event ? { ...event, raw: JSON.parse(decoder.decode(event.raw)) } : event);
	scanner.finish();
	return events;
}

const tricky = {
	format: "kite-database-backup",
	version: 1,
	includedTables: ["users"],
	tables: {
		users: [
			{ id: "u1", name: 'Quote " and ] and } and \\ and [ { ,', bio: "שלום עולם — مرحبا 🪁" },
			{ id: "u2", name: null, count: -1.5e3, active: true },
		],
		empty: [],
		other: "not an array",
	},
	createdAt: "2026-10-29T00:00:00.000Z",
};

test("the scanner gives the same events whatever the page size, pretty-printed or not", () => {
	for (const text of [JSON.stringify(tricky), JSON.stringify(tricky, null, "\t"), `﻿ ${JSON.stringify(tricky)}\n`]) {
		const bytes = encoder.encode(text);
		const whole = scan(bytes, bytes.byteLength);
		for (const size of [1, 2, 3, 7, 13, 64]) assert.deepEqual(scan(bytes, size), whole, `page size ${size}`);
		const members = Object.fromEntries(whole.filter((e) => e.type === "member").map((e) => [e.key, e.raw]));
		assert.deepEqual(members, {
			format: "kite-database-backup",
			version: 1,
			includedTables: ["users"],
			createdAt: "2026-10-29T00:00:00.000Z",
		});
		assert.deepEqual(
			whole.filter((e) => e.type === "row").map((e) => e.raw),
			tricky.tables.users,
		);
		assert.deepEqual(
			whole.find((e) => e.type === "tableValue"),
			{
				type: "tableValue",
				name: "other",
				raw: "not an array",
			},
		);
		// A table's recorded range is exactly its array, which "rows" mode reads back.
		const start = whole.find((e) => e.type === "tableStart" && e.name === "users").start;
		const end = whole.find((e) => e.type === "tableEnd" && e.name === "users").end;
		const rows = scan(bytes.subarray(start, end), 5, "rows").filter((e) => e.type === "row");
		assert.deepEqual(
			rows.map((e) => e.raw),
			tricky.tables.users,
		);
	}
});

test("the scanner refuses anything that is not one complete document", () => {
	for (const text of [
		"",
		"[]",
		'{"tables":{"users":[{"id":1}]}',
		'{"tables":{"users":[{"id":1}]}} trailing',
		'{"format":}',
		'{"format" "x"}',
		'{"a":1,,"b":2}',
		'{"tables":{"users":[{"id":1},]}}',
		"{format:1}",
	]) {
		assert.throws(() => scan(encoder.encode(text), 4), /not a valid Kite backup/, JSON.stringify(text));
	}
});

test("pages cover exactly the requested range and never exceed the page size", async () => {
	const bytes = encoder.encode("0123456789abcdefghij");
	const reads = [];
	const source = {
		size: bytes.byteLength,
		pageSize: 6,
		async read(offset, length) {
			reads.push([offset, length]);
			return bytes.subarray(offset, offset + length);
		},
	};
	const pages = [];
	for await (const page of lib.readSourcePages(source, 3, 17)) pages.push(decoder.decode(page));
	assert.equal(pages.join(""), "3456789abcdefg");
	assert.deepEqual(reads, [
		[3, 6],
		[9, 6],
		[15, 2],
	]);
	const short = { ...source, read: async () => bytes.subarray(0, 1) };
	await assert.rejects(async () => {
		for await (const _ of lib.readSourcePages(short)) void _;
	}, /changed or could not be read/);
});

const MESSAGES = 3000;

async function seededDatabase(t) {
	const db = new lib.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await lib.applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'alex', 'personal', 1);
	`);
	const insert = db.db.prepare(
		"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES (?, 'owner', 'mailbox-a', 'inbound', 'a@outside.test', 'alex@example.com', ?, ?, 'received', ?)",
	);
	db.db.exec("BEGIN");
	for (let index = 0; index < MESSAGES; index++)
		insert.run(`msg-${index}`, `Subject ${index} “quoted”`, `Body ${index} ${"x".repeat(index % 200)}`, index);
	db.db.exec("COMMIT");
	return db;
}

function messageDigest(db) {
	return db.db.prepare("SELECT count(*) AS count, group_concat(subject, '|') AS subjects FROM messages").get();
}

function bucket() {
	return new lib.FileBucket(mkdtempSync(join(bucketRoot, "b-")));
}

test("a backup of several thousand messages restores from storage in pages and batches", async (t) => {
	const db = await seededDatabase(t);
	const expected = messageDigest(db);
	const document = await lib.exportDatabaseRecords(db);
	const files = bucket();
	await files.put("backups/database/big.json", document);

	db.db.exec("DELETE FROM messages; DELETE FROM mailboxes WHERE id = 'mailbox-a'");
	const source = await lib.bucketBackupSource(files, "backups/database/big.json", 4096);
	let largestRead = 0;
	let bytesRead = 0;
	const counted = {
		...source,
		async read(offset, length) {
			largestRead = Math.max(largestRead, length);
			bytesRead += length;
			return source.read(offset, length);
		},
	};
	const prepared = await lib.prepareDatabaseRestore(db, counted);
	assert.equal(prepared.tables.find((table) => table.name === "messages").range.rows, MESSAGES);
	const writer = new lib.RestoreBatchWriter(db, { maxStatements: 100, maxBytes: 500_000 });
	assert.equal(await lib.executeDatabaseRestore(db, prepared, { writer }), null);

	assert.deepEqual(messageDigest(db), expected);
	assert.ok(writer.committedBatches > 5, `${writer.committedBatches} batches`);
	assert.equal(largestRead, 4096);
	// Validation reads the file once, the restore reads each table's range once more.
	assert.ok(bytesRead <= document.byteLength * 2, `${bytesRead} of ${document.byteLength}`);
});

test("an invalid row fails validation before anything is written", async (t) => {
	const db = await seededDatabase(t);
	const document = JSON.parse(decoder.decode(await lib.exportDatabaseRecords(db)));
	document.tables.messages.push(42);
	await assert.rejects(
		lib.restoreDatabaseRecords(db, encoder.encode(JSON.stringify(document))),
		/invalid messages record/,
	);
	assert.equal(messageDigest(db).count, MESSAGES);
});

/** An upload request body, arriving in chunks. */
function upload(bytes) {
	return new ReadableStream({
		start(controller) {
			for (let offset = 0; offset < bytes.byteLength; offset += 100_000)
				controller.enqueue(bytes.slice(offset, offset + 100_000));
			controller.close();
		},
	});
}

/** The env the restore job runs with; the outbound queue keeps its messages until `drain` runs them. */
function jobEnv(db, files = bucket()) {
	const messages = [];
	return {
		DB: db,
		BUCKET: files,
		OUTBOUND_QUEUE: {
			messages,
			async send(body) {
				messages.push(body);
			},
		},
	};
}

/** Runs the queued restore messages, as the consumer would, until none are left; returns how many ran. */
async function drain(env, options = {}) {
	let count = 0;
	while (env.OUTBOUND_QUEUE.messages.length) {
		await lib.processRestoreMessage(env, env.OUTBOUND_QUEUE.messages.shift(), options);
		count++;
	}
	return count;
}

async function restoreJob(env) {
	return (await lib.readRestoreJob(env.BUCKET))?.job ?? null;
}

/** A database whose batches fail while `shouldFail(call, sqls)` says so. */
function failing(db, shouldFail) {
	const wrapped = Object.create(db);
	let calls = 0;
	wrapped.batch = async (statements) => {
		calls++;
		if (
			shouldFail(
				calls,
				statements.map((statement) => statement.sql),
			)
		)
			throw new Error("batch failed");
		return db.batch(statements);
	};
	return wrapped;
}

const SMALL_BATCHES = { limits: { maxStatements: 20, maxBytes: 200_000 } };
/** Room for every DELETE and a few inserts in the first batch, so committing it changes the messages. */
const FIRST_BATCH_EMPTIES = { limits: { maxStatements: 100, maxBytes: 500_000 } };

function backupRows(db) {
	return db.db.prepare("SELECT trigger, status FROM backups ORDER BY trigger").all();
}

test("an uploaded backup is restored by the queued job, and the upload is removed", async (t) => {
	const db = await seededDatabase(t);
	const expected = messageDigest(db);
	const backup = await lib.exportDatabaseRecords(db);
	db.db.exec("DELETE FROM messages");
	const env = jobEnv(db);
	const started = await lib.startUploadedRestore(env, upload(backup), "owner");
	assert.equal(started.status, "validating");
	assert.deepEqual(env.OUTBOUND_QUEUE.messages, [{ kind: "backup.restore", restoreId: started.id, seq: 0 }]);
	await drain(env);

	assert.deepEqual(messageDigest(db), expected);
	const job = await restoreJob(env);
	assert.equal(job.status, "completed");
	assert.equal(job.lease, null);
	assert.ok(job.rowCount > MESSAGES);
	assert.deepEqual((await env.BUCKET.list({ prefix: "backups/uploads/" })).objects, []);
	assert.equal((await env.BUCKET.list({ prefix: "backups/database/" })).objects.length, 1, "the safety backup");
	assert.deepEqual(backupRows(db), [{ trigger: "pre-restore", status: "completed" }]);
});

test("a restore runs in chunks across queue messages when its time is up", async (t) => {
	const db = await seededDatabase(t);
	const expected = messageDigest(db);
	const files = bucket();
	await files.put("backups/database/full.json", await lib.exportDatabaseRecords(db));
	db.db.exec("UPDATE messages SET subject = 'changed' WHERE id LIKE 'msg-1%'");
	db.db.exec(
		"INSERT INTO backups (id, status, `trigger`, r2_key, filename, size, created_at, completed_at) VALUES ('bak-full', 'completed', 'manual', 'backups/database/full.json', 'full.json', 1, 1, 2)",
	);
	const env = jobEnv(db, files);
	await lib.startStoredRestore(env, "bak-full", "owner");
	const messages = await drain(env, { ...SMALL_BATCHES, chunkMs: 0 });

	assert.ok(messages > 10, `${messages} messages`);
	assert.deepEqual(messageDigest(db), expected);
	assert.equal((await restoreJob(env)).status, "completed");
	// The restored backup is newer than the data it restored and stays listed, next to the safety backup.
	assert.deepEqual(backupRows(db), [
		{ trigger: "manual", status: "completed" },
		{ trigger: "pre-restore", status: "completed" },
	]);
});

test("a restore that fails after a committed batch is rolled back from the safety backup", async (t) => {
	const db = await seededDatabase(t);
	const backup = await lib.exportDatabaseRecords(db);
	db.db.exec("UPDATE messages SET subject = 'changed after the backup' WHERE id = 'msg-1'");
	const before = messageDigest(db);

	const env = jobEnv(
		failing(db, (call) => call === 3),
		bucket(),
	);
	await lib.startUploadedRestore(env, upload(backup), "owner");
	await drain(env, SMALL_BATCHES);
	const job = await restoreJob(env);
	assert.equal(job.status, "rolled_back");
	assert.equal(job.error, "batch failed");
	assert.equal(job.needsRecovery, false);
	assert.deepEqual(messageDigest(db), before);
	assert.deepEqual(backupRows(db), [{ trigger: "pre-restore", status: "completed" }]);
	assert.deepEqual((await env.BUCKET.list({ prefix: "backups/uploads/" })).objects, []);
});

test("a restore that fails before the checkpoint after a committed batch still rolls back", async (t) => {
	const db = await seededDatabase(t);
	const backup = await lib.exportDatabaseRecords(db);
	db.db.exec("UPDATE messages SET subject = 'changed after the backup' WHERE id = 'msg-1'");
	const before = messageDigest(db);
	let commits = 0;
	const counting = Object.create(db);
	counting.batch = async (statements) => {
		const result = await db.batch(statements);
		commits++;
		return result;
	};
	// The checkpoint before the second batch cannot be written, so no checkpoint shows the first one landed.
	const files = bucket();
	const flaky = Object.create(files);
	let thrown = false;
	flaky.put = async (key, ...rest) => {
		if (key === "system/backup-restore.json" && commits === 1 && !thrown) {
			thrown = true;
			throw new Error("storage unavailable");
		}
		return files.put(key, ...rest);
	};
	const env = jobEnv(counting, flaky);
	await lib.startUploadedRestore(env, upload(backup), "owner");
	await drain(env, FIRST_BATCH_EMPTIES);
	const job = await restoreJob(env);
	assert.equal(job.status, "rolled_back", job.error);
	assert.equal(job.error, "storage unavailable");
	assert.deepEqual(messageDigest(db), before);
});

test("a restore whose first batch reports an error rolls back, since its answer may have been lost", async (t) => {
	const db = await seededDatabase(t);
	const backup = await lib.exportDatabaseRecords(db);
	db.db.exec("UPDATE messages SET subject = 'changed after the backup' WHERE id = 'msg-1'");
	const before = messageDigest(db);
	const env = jobEnv(
		failing(db, (call) => call === 1),
		bucket(),
	);
	await lib.startUploadedRestore(env, upload(backup), "owner");
	await drain(env, SMALL_BATCHES);
	const job = await restoreJob(env);
	assert.equal(job.status, "rolled_back", job.error);
	assert.equal(job.error, "batch failed");
	assert.deepEqual(messageDigest(db), before);
});

test("a restore that fails before sending any batch changes nothing and needs no rollback", async (t) => {
	const db = await seededDatabase(t);
	const backup = await lib.exportDatabaseRecords(db);
	const before = messageDigest(db);
	const env = jobEnv(db);
	const started = await lib.startUploadedRestore(env, upload(backup), "owner");
	// Validation and the snapshot, one message each; then the upload disappears before anything is written.
	await lib.processRestoreMessage(env, env.OUTBOUND_QUEUE.messages.shift(), { chunkMs: 0 });
	await lib.processRestoreMessage(env, env.OUTBOUND_QUEUE.messages.shift(), { chunkMs: 0 });
	assert.equal((await restoreJob(env)).status, "restoring");
	await env.BUCKET.delete(started.source.key);
	await drain(env);
	const job = await restoreJob(env);
	assert.equal(job.status, "failed");
	assert.equal(job.changed, false);
	assert.equal(job.rollbackPlan, null);
	assert.deepEqual(messageDigest(db), before);
});

test("the second pass throws after a committed batch, so the caller knows it must roll back", async (t) => {
	const db = await seededDatabase(t);
	const backup = await lib.exportDatabaseRecords(db);
	const target = failing(db, (call) => call === 2);
	const prepared = await lib.prepareDatabaseRestore(target, backup);
	const writer = new lib.RestoreBatchWriter(target, FIRST_BATCH_EMPTIES.limits);
	await assert.rejects(lib.executeDatabaseRestore(target, prepared, { writer }), /batch failed/);
	assert.equal(writer.committedBatches, 1);
	assert.ok(messageDigest(db).count < MESSAGES, "the first batch emptied the tables");
});

test("the rollback leaves the storage tables as they were when the install had no stores before the restore", async (t) => {
	const db = await seededDatabase(t);
	db.db.exec(`
		INSERT INTO storage_stores (id, name, provider, endpoint, region, bucket, credentials, created_at, updated_at) VALUES ('store-1', 'Old store', 's3', 'https://s3.example.com', 'auto', 'old', 'sealed', 1, 1);
		INSERT INTO storage_routes (object_class, store_id, updated_at) VALUES ('backups', 'store-1', 1);
	`);
	const backup = await lib.exportDatabaseRecords(db);
	db.db.exec("DELETE FROM storage_routes; DELETE FROM storage_stores");
	const before = messageDigest(db);

	// Fails once the backup's storage rows are in, on the first batch that writes app_settings.
	let failed = false;
	const env = jobEnv(
		failing(db, (_call, sqls) => {
			if (failed || !sqls.some((sql) => sql.startsWith("INSERT INTO `app_settings`"))) return false;
			return (failed = true);
		}),
		bucket(),
	);
	await lib.startUploadedRestore(env, upload(backup), "owner");
	await drain(env, SMALL_BATCHES);

	const job = await restoreJob(env);
	assert.equal(job.status, "rolled_back", job.error);
	assert.deepEqual(job.plan.preserved, []);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM storage_stores").get().count, 0);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM storage_routes").get().count, 0);
	assert.deepEqual(messageDigest(db), before);
});

/**
 * A database whose `at`-th batch never returns, like an invocation killed mid-batch; `commit` lands it first.
 * `reached` resolves once that batch started.
 */
function dyingAt(db, at, commit) {
	const wrapped = Object.create(db);
	let calls = 0;
	let reach;
	const reached = new Promise((resolve) => (reach = resolve));
	wrapped.batch = async (statements) => {
		calls++;
		if (calls !== at) return db.batch(statements);
		if (commit) await db.batch(statements);
		reach();
		return new Promise(() => {});
	};
	return { db: wrapped, reached };
}

/** Expires the lease the dead invocation left behind, as time would. */
async function expireLease(env) {
	const stored = await lib.readRestoreJob(env.BUCKET);
	await lib.writeRestoreJob(env.BUCKET, { ...stored.job, lease: { ...stored.job.lease, until: 0 } }, stored.etag);
}

/** A stored backup of `db` as it is now, listed so it can be restored; then `change` runs on the live data. */
async function storedBackup(db, files, change = "UPDATE messages SET subject = 'changed' WHERE id LIKE 'msg-2%'") {
	await files.put("backups/database/full.json", await lib.exportDatabaseRecords(db));
	db.db.exec(
		"INSERT INTO backups (id, status, `trigger`, r2_key, filename, size, created_at, completed_at) VALUES ('bak-full', 'completed', 'manual', 'backups/database/full.json', 'full.json', 1, 1, 2)",
	);
	db.db.exec(change);
}

/** Starts restoring `bak-full` and lets its first invocation die in batch `at`; returns the message and the state. */
async function dieDuringRestore(db, env, at, commit, options) {
	await lib.startStoredRestore(env, "bak-full", "owner");
	const message = env.OUTBOUND_QUEUE.messages.shift();
	const dying = dyingAt(db, at, commit);
	void lib.processRestoreMessage({ ...env, DB: dying.db }, message, options);
	await dying.reached;
	return { message, dead: await restoreJob(env) };
}

// Production batch limits put every DELETE in batch 1 and inserts from batch 2 on; small ones split everything.
for (const [limits, at] of [
	[undefined, 1],
	[undefined, 2],
	[SMALL_BATCHES, 5],
])
	for (const commit of [false, true]) {
		const name = `${limits ? "small batches" : "production batches"}, batch ${at} ${commit ? "landed" : "lost"}`;
		test(`an interrupted restore resumes from its checkpoint (${name})`, async (t) => {
			const db = await seededDatabase(t);
			const expected = messageDigest(db);
			const files = bucket();
			await storedBackup(db, files);
			const env = jobEnv(db, files);
			const options = limits ?? {};
			const { message, dead } = await dieDuringRestore(db, env, at, commit, options);
			assert.equal(dead.status, "restoring");
			assert.ok(dead.lease && dead.cursor.pending, "a lease and the pending batch are left behind");

			// Redelivered while the lease still runs, the message is skipped; once it expired, the job resumes.
			await lib.processRestoreMessage(env, message, options);
			assert.equal((await restoreJob(env)).interruptions, 0);
			await expireLease(env);
			env.OUTBOUND_QUEUE.messages.push(message);
			await drain(env, options);

			const job = await restoreJob(env);
			assert.equal(job.status, "completed", job.error);
			assert.equal(job.interruptions, 1);
			assert.deepEqual(messageDigest(db), expected);
		});
	}

test("a row created under the key of a lost batch's last row does not pass for it", async (t) => {
	const db = await seededDatabase(t);
	const files = bucket();
	await storedBackup(db, files);
	const before = messageDigest(db);
	const env = jobEnv(db, files);
	const { message, dead } = await dieDuringRestore(db, env, 2, false, {});
	const { probe } = dead.cursor.pending;
	assert.equal(probe.table, "messages");
	// Someone writes a row with that key meanwhile (the mailbox it names was emptied with the rest).
	db.db.exec("PRAGMA foreign_keys = OFF");
	db.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES (?, 'owner', 'mailbox-a', 'inbound', 'a@outside.test', 'alex@example.com', 'concurrent', 'received', 1)",
		)
		.run(probe.key.id);
	db.db.exec("PRAGMA foreign_keys = ON");
	await expireLease(env);
	env.OUTBOUND_QUEUE.messages.push(message);
	await drain(env);

	// The batch runs again, meets that row and the restore rolls back instead of finishing without the batch.
	const job = await restoreJob(env);
	assert.equal(job.status, "rolled_back", job.error);
	assert.match(job.error, /UNIQUE constraint failed: messages.id/);
	assert.deepEqual(messageDigest(db), before);
});

/** A database whose batches do what `script(call)` says: "fail", "die" (never answer) or run normally. */
function scripted(db, script) {
	const wrapped = Object.create(db);
	let calls = 0;
	let reach;
	const died = new Promise((resolve) => (reach = resolve));
	wrapped.batch = async (statements) => {
		const action = script(++calls);
		if (action === "fail") throw new Error("batch failed");
		if (action !== "die") return db.batch(statements);
		reach();
		return new Promise(() => {});
	};
	return { db: wrapped, died };
}

test("an interrupted rollback resumes from its checkpoint", async (t) => {
	const db = await seededDatabase(t);
	const files = bucket();
	await storedBackup(db, files);
	const before = messageDigest(db);
	const env = jobEnv(db, files);
	await lib.startStoredRestore(env, "bak-full", "owner");
	const message = env.OUTBOUND_QUEUE.messages.shift();
	// Batch 3 of the restore fails; the rollback's sixth batch overall never answers.
	const run = scripted(db, (call) => (call === 3 ? "fail" : call === 6 ? "die" : undefined));
	void lib.processRestoreMessage({ ...env, DB: run.db }, message, SMALL_BATCHES);
	await run.died;
	const dead = await restoreJob(env);
	assert.equal(dead.status, "rolling_back");
	assert.ok(dead.rollbackPlan && dead.cursor.pending);

	await expireLease(env);
	env.OUTBOUND_QUEUE.messages.push(message);
	await drain(env, SMALL_BATCHES);
	const job = await restoreJob(env);
	assert.equal(job.status, "rolled_back", job.error);
	assert.equal(job.error, "batch failed");
	assert.deepEqual(messageDigest(db), before);
});

/** Runs the queued messages one at a time until `until(job)` holds, with one step per message. */
async function stepUntil(env, until, options = {}) {
	while (!until(await restoreJob(env))) {
		const message = env.OUTBOUND_QUEUE.messages.shift();
		assert.ok(message, "the job stopped before the expected state");
		await lib.processRestoreMessage(env, message, { ...options, chunkMs: 0 });
	}
}

async function patchJob(env, patch) {
	const stored = await lib.readRestoreJob(env.BUCKET);
	await lib.writeRestoreJob(env.BUCKET, { ...stored.job, ...patch }, stored.etag);
}

for (const [cause, change] of [
	["Kite is updated", (env) => patchJob(env, { version: 0 })],
	[
		"database updates are applied",
		(_env, db) => db.db.exec("INSERT INTO d1_migrations (name) VALUES ('9999_applied_during_the_restore')"),
	],
]) {
	test(`a restore rolls back when ${cause} after it started writing`, async (t) => {
		const db = await seededDatabase(t);
		const files = bucket();
		await storedBackup(db, files);
		const before = messageDigest(db);
		const env = jobEnv(db, files);
		await lib.startStoredRestore(env, "bak-full", "owner");
		await stepUntil(env, (job) => job.changed && job.cursor?.at.segment > 1, SMALL_BATCHES);
		await change(env, db);
		await drain(env, SMALL_BATCHES);
		const job = await restoreJob(env);
		assert.equal(job.status, "rolled_back", job.error);
		assert.match(job.error, /updated|Database updates/);
		assert.deepEqual(messageDigest(db), before);
	});

	test(`a restore starts over when ${cause} before it wrote anything`, async (t) => {
		const db = await seededDatabase(t);
		const expected = messageDigest(db);
		const files = bucket();
		await storedBackup(db, files);
		const env = jobEnv(db, files);
		await lib.startStoredRestore(env, "bak-full", "owner");
		await stepUntil(env, (job) => job.status === "snapshot");
		await change(env, db);
		await drain(env, SMALL_BATCHES);
		const job = await restoreJob(env);
		assert.equal(job.status, "completed", job.error);
		assert.deepEqual(messageDigest(db), expected);
	});
}

test("only one restore runs at a time", async (t) => {
	const db = await seededDatabase(t);
	const backup = await lib.exportDatabaseRecords(db);
	const env = jobEnv(db);
	await lib.startUploadedRestore(env, upload(backup), "owner");
	await assert.rejects(lib.startUploadedRestore(env, upload(backup), "owner"), lib.RestoreBusyError);
	assert.equal(
		(await env.BUCKET.list({ prefix: "backups/uploads/" })).objects.length,
		1,
		"the second upload is not kept",
	);
	await drain(env);
	await lib.startUploadedRestore(env, upload(backup), "owner");
});

test("a restore whose rollback fails too is recovered from its safety backup, and nothing else starts meanwhile", async (t) => {
	const db = await seededDatabase(t);
	const backup = await lib.exportDatabaseRecords(db);
	db.db.exec("UPDATE messages SET subject = 'changed after the backup' WHERE id = 'msg-1'");
	const before = messageDigest(db);
	const files = bucket();
	const env = jobEnv(
		failing(db, (call) => call >= 2),
		files,
	);
	const original = await lib.startUploadedRestore(env, upload(backup), "owner");
	await drain(env, FIRST_BATCH_EMPTIES);
	const job = await restoreJob(env);
	assert.equal(job.status, "failed");
	assert.equal(job.needsRecovery, true);
	assert.match(job.error, /batch failed, and the automatic rollback also failed: batch failed/);
	assert.notDeepEqual(messageDigest(db), before);
	const snapshots = async () => (await files.list({ prefix: "backups/database/" })).objects.length;
	assert.equal(await snapshots(), 1);

	// No other restore may start before the previous data is back.
	await assert.rejects(
		lib.startUploadedRestore(jobEnv(db, files), upload(backup), "owner"),
		lib.RestoreRecoveryPendingError,
	);

	// A recovery that fails leaves everything as it was: still to be recovered, from the same snapshot.
	const failingRecovery = jobEnv(
		failing(db, (call) => call >= 2),
		files,
	);
	const first = await lib.startSafetyRecovery(failingRecovery, "owner");
	assert.equal(first.source.key, job.safety.r2Key);
	assert.equal(first.needsRecovery, true);
	await drain(failingRecovery, FIRST_BATCH_EMPTIES);
	const failed = await restoreJob(failingRecovery);
	assert.equal(failed.status, "failed");
	assert.equal(failed.needsRecovery, true);
	assert.equal(failed.safety.id, job.safety.id);
	assert.deepEqual(failed.recoveryOf, { id: original.id, error: job.error });
	assert.equal(failed.rollbackPlan, null, "a recovery never rolls back");
	assert.equal(await snapshots(), 1, "a recovery takes no snapshot of the broken data");
	await assert.rejects(
		lib.startUploadedRestore(jobEnv(db, files), upload(backup), "owner"),
		lib.RestoreRecoveryPendingError,
	);

	const recovery = jobEnv(db, files);
	const second = await lib.startSafetyRecovery(recovery, "owner");
	assert.deepEqual(second.recoveryOf, { id: original.id, error: job.error });
	await drain(recovery, SMALL_BATCHES);
	const done = await restoreJob(recovery);
	assert.equal(done.status, "completed", done.error);
	assert.equal(done.needsRecovery, false);
	assert.deepEqual(messageDigest(db), before);
	assert.equal(await lib.startSafetyRecovery(recovery, "owner"), null, "nothing left to recover");
	await lib.startUploadedRestore(jobEnv(db, files), upload(backup), "owner");
});

/**
 * Holds `parties` reads of `key` (after the first `skip`) until all of them arrived, so they all see the same
 * version.
 */
function barrier(files, key, parties = 2, skip = 0) {
	const wrapped = Object.create(files);
	const waiting = [];
	let open = false;
	let reads = 0;
	wrapped.get = async (name, options) => {
		if (name === key && !open && ++reads > skip)
			await new Promise((resolve) => {
				waiting.push(resolve);
				if (waiting.length === parties) {
					open = true;
					for (const release of waiting) release();
				}
			});
		return files.get(name, options);
	};
	return wrapped;
}

test("two invocations delivered the same message at once: only one claims the job", async (t) => {
	const db = await seededDatabase(t);
	const expected = messageDigest(db);
	const backup = await lib.exportDatabaseRecords(db);
	db.db.exec("DELETE FROM messages WHERE id LIKE 'msg-1%'");
	const files = bucket();
	const env = jobEnv(db, files);
	await lib.startUploadedRestore(env, upload(backup), "owner");
	const message = env.OUTBOUND_QUEUE.messages.shift();
	const racing = { ...env, BUCKET: barrier(files, "system/backup-restore.json") };
	await Promise.all([lib.processRestoreMessage(racing, message), lib.processRestoreMessage(racing, message)]);
	const job = await restoreJob(env);
	assert.equal(job.status, "completed", job.error);
	assert.equal(job.interruptions, 0);
	assert.equal((await files.list({ prefix: "backups/database/" })).objects.length, 1, "one snapshot, one restore");
	assert.deepEqual(messageDigest(db), expected);
});

test("two restores started at once on a fresh install: the state is created only once", async (t) => {
	const db = await seededDatabase(t);
	const backup = await lib.exportDatabaseRecords(db);
	const files = bucket();
	// The reads held are the ones just before the state is written, after both uploads were stored.
	const env = jobEnv(db, barrier(files, "system/backup-restore.json", 2, 2));
	const results = await Promise.allSettled([
		lib.startUploadedRestore(env, upload(backup), "owner"),
		lib.startUploadedRestore(env, upload(backup), "owner"),
	]);
	assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
	assert.ok(results.find((result) => result.status === "rejected").reason instanceof lib.RestoreBusyError);
	assert.equal((await files.list({ prefix: "backups/uploads/" })).objects.length, 1, "the loser's upload is gone");
	assert.equal(env.OUTBOUND_QUEUE.messages.length, 1);
});

test("the cron revives a stalled restore, gives up an abandoned one and sweeps old uploads", async (t) => {
	const db = await seededDatabase(t);
	const backup = await lib.exportDatabaseRecords(db);
	const env = jobEnv(db);
	const started = await lib.startUploadedRestore(env, upload(backup), "owner");
	await env.BUCKET.put("backups/uploads/left-behind.json", "{}");
	env.OUTBOUND_QUEUE.messages.length = 0;

	// The first message was lost: three minutes later the cron sends it again; the active upload is kept.
	await lib.runRestoreMaintenance(env, new Date(Date.now() + 3 * 60_000));
	assert.deepEqual(env.OUTBOUND_QUEUE.messages, [{ kind: "backup.restore", restoreId: started.id, seq: 0 }]);
	env.OUTBOUND_QUEUE.messages.length = 0;

	// Two days on, the job is given up and old uploads go, including its own.
	await lib.runRestoreMaintenance(env, new Date(Date.now() + 2 * 86_400_000));
	const job = await restoreJob(env);
	assert.equal(job.status, "failed");
	assert.equal(job.needsRecovery, false, "nothing was written yet");
	assert.match(job.error, /stopped making progress/);
	assert.deepEqual((await env.BUCKET.list({ prefix: "backups/uploads/" })).objects, []);
});

test("rows a restore could not insert fail validation before anything is written", async (t) => {
	const db = await seededDatabase(t);
	const document = JSON.parse(decoder.decode(await lib.exportDatabaseRecords(db)));
	const cases = [
		[{ ...document, tables: { ...document.tables, contacts: [{ unknown_column: 1 }] } }, /invalid contacts record/],
		[
			{ ...document, tables: { ...document.tables, contacts: [{ id: "c", email: { nested: true } }] } },
			/invalid contacts record/,
		],
		[
			{
				...document,
				tables: { ...document.tables, messages: [{ ...document.tables.messages[0], subject: ["an", "array"] }] },
			},
			/invalid messages record/,
		],
		[
			{ ...document, tables: { ...document.tables, message_bodies: [{ text_body: "no message id" }] } },
			/message_bodies/,
		],
	];
	for (const [bad, error] of cases) {
		await assert.rejects(lib.restoreDatabaseRecords(db, encoder.encode(JSON.stringify(bad))), error);
		assert.equal(messageDigest(db).count, MESSAGES);
	}
	// No table has that many columns yet; the check is on the columns a row shares with its table.
	const wide = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`c${index}`, index]));
	const columns = new Set(Object.keys(wide));
	assert.match(lib.restoreRowError("wide", wide, columns), /more columns than a restore can insert/);
	assert.equal(lib.restoreRowError("wide", { c1: 1, other: { ignored: true } }, columns), null);
	assert.equal(lib.restoreRowError("wide", { c1: true, c2: null }, columns), null);
});

test("a second tables object is refused rather than merged", async (t) => {
	const db = await seededDatabase(t);
	const text = decoder.decode(await lib.exportDatabaseRecords(db));
	const doubled = `${text.slice(0, -1)},"tables":{"contacts":[]}}`;
	await assert.rejects(lib.restoreDatabaseRecords(db, encoder.encode(doubled)), /not a valid Kite backup/);
	assert.equal(messageDigest(db).count, MESSAGES);
});

test("a table whose rows changed between the two passes stops the restore", async (t) => {
	const db = await seededDatabase(t);
	const bytes = await lib.exportDatabaseRecords(db);
	const prepared = await lib.prepareDatabaseRestore(db, bytes);
	// Same length, one row fewer: the first message and the comma after it become spaces.
	const text = decoder.decode(bytes);
	const start = encoder.encode(text.slice(0, text.indexOf('{"id":"msg-0"'))).byteLength;
	const end = encoder.encode(text.slice(0, text.indexOf('{"id":"msg-1"'))).byteLength;
	const changed = bytes.slice();
	changed.fill(0x20, start, end);
	await assert.rejects(
		lib.executeDatabaseRestore(db, {
			...prepared,
			source: { size: changed.byteLength, read: async (o, l) => changed.subarray(o, o + l) },
		}),
		/changed or could not be read while restoring/,
	);
});
