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
			export { exportDatabaseRecords, executeDatabaseRestore, prepareDatabaseRestore, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
			export { restoreUploadedBackup } from "./src/lib/backups/restore.ts";
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
	await lib.executeDatabaseRestore(db, prepared, writer);

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

/** A database whose `failAt`-th batch fails once. */
function failingOnce(db, failAt) {
	const wrapped = Object.create(db);
	let calls = 0;
	wrapped.batch = async (statements) => {
		calls++;
		if (calls === failAt) throw new Error("batch failed");
		return db.batch(statements);
	};
	return wrapped;
}

test("a restore that fails part way is rolled back from the safety backup in storage", async (t) => {
	const db = await seededDatabase(t);
	const files = bucket();
	const backup = await lib.exportDatabaseRecords(db);
	db.db.exec("UPDATE messages SET subject = 'changed after the backup' WHERE id = 'msg-1'");
	const before = messageDigest(db);

	const env = { DB: failingOnce(db, 3), BUCKET: files };
	await assert.rejects(
		lib.restoreUploadedBackup(env, upload(backup), "owner"),
		/previous data was put back from the "pre-restore-kite-.*" backup: batch failed/,
	);
	assert.deepEqual(messageDigest(db), before);
	const safety = db.db.prepare("SELECT trigger, status FROM backups").all();
	assert.deepEqual(safety, [{ trigger: "pre-restore", status: "completed" }]);

	const first = { DB: failingOnce(db, 1), BUCKET: files };
	await assert.rejects(lib.restoreUploadedBackup(first, upload(backup), "owner"), /nothing was changed: batch failed/);
	assert.deepEqual(messageDigest(db), before);
});

test("an uploaded backup is streamed to storage, restored and removed", async (t) => {
	const db = await seededDatabase(t);
	const expected = messageDigest(db);
	const backup = await lib.exportDatabaseRecords(db);
	db.db.exec("DELETE FROM messages");
	const files = bucket();
	const outcome = await lib.restoreUploadedBackup({ DB: db, BUCKET: files }, upload(backup), "owner");
	assert.deepEqual(messageDigest(db), expected);
	assert.equal(outcome.atomic, false);
	assert.ok(outcome.rowCount > MESSAGES);
	assert.deepEqual((await files.list({ prefix: "backups/uploads/" })).objects, []);
	assert.equal((await files.list({ prefix: "backups/database/" })).objects.length, 1, "the safety backup");
});
