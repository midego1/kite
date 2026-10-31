import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { FIXTURES } from "./fixtures/mime/fixtures.mjs";

// docs/specs/attachments-once.md §8 step 6: restores across the attachment storage migrations. A backup from before
// migrations 0088 and 0090 restores into the current schema; a stored job from an old backup starts nothing; and a
// newer backup that an older release restored into a database without 0088 reads again once the migration is applied.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle", "migrations");
const STORAGE_MIGRATION = "0088_attachment_raw_storage.sql";
const JOB_MIGRATION = "0090_add_attachment_storage_job.sql";
const directory = makeBundleDirectory("kite-attachment-restore-test-");
const scratch = mkdtempSync(join(tmpdir(), "kite-attachment-restore-"));
after(() => {
	rmSync(directory, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { FileBucket } from "./server/runtime/file-bucket.ts";
			export { exportDatabaseRecords, prepareDatabaseRestore, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
			export { executeDatabaseRestore } from "./src/lib/backups/restore-engine.ts";
			export { openAttachment, readAttachmentBytes } from "./src/lib/email/attachment-storage.ts";
			export { getAttachmentStorageCounts, getReclaimCounts } from "./src/lib/email/attachment-storage-report.ts";
			export { storeMessageAttachments } from "./src/lib/email/attachments.ts";
			export { parseRawMime } from "./src/lib/email/parse.ts";
			export {
				cancelAttachmentJob,
				getAttachmentJobStatus,
				processAttachmentJob,
				runAttachmentJobMaintenance,
				startAttachmentJob,
			} from "./src/lib/email/attachment-storage-jobs.ts";
			export { REVIVE_WINDOW_MS } from "./src/lib/email/attachment-storage-jobs-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "attachment-restore-test-entry.ts",
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
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let counter = 0;
const ADMIN = { id: "owner" };
const RAW_KEY = "inbound/1-a.eml";
/** Two base64 attachments, both of which the raw index verifies. */
const FIXTURE = "related inside alternative inside mixed, with an inline cid image";

/** The repository's migrations without `skipped`, so a database can be left a release behind. */
function migrationsWithout(skipped) {
	if (!skipped.length) return migrationsDir;
	const copy = join(scratch, `migrations-${++counter}`);
	mkdirSync(copy, { recursive: true });
	for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql") && !skipped.includes(file)))
		copyFileSync(join(migrationsDir, name), join(copy, name));
	return copy;
}

function fakeQueue() {
	const sent = [];
	return { sent, send: async (body, options) => void sent.push({ body, delaySeconds: options?.delaySeconds }) };
}

/** A database at the given schema with one received message, sharing `bucket` when given (the raw lives there). */
async function setup({ skip = [], bucket } = {}) {
	const database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, migrationsWithout(skip));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'support', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at)
			VALUES ('msg-a', 'owner', 'mailbox-a', 'inbound', 'sender@example.com', 'support@example.com', 'Fixture', 'received', '${RAW_KEY}', 1);
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
	`);
	const files = bucket ?? new m.FileBucket(join(scratch, `bucket-${++counter}`));
	const queue = fakeQueue();
	return { database, bucket: files, queue, env: { DB: database, BUCKET: files, OUTBOUND_QUEUE: queue } };
}

/** Stores the fixture's raw and its attachments, as objects or (`asRaw`) as 'raw' rows. */
async function deliver(env, { asRaw = false } = {}) {
	const raw = encoder.encode(FIXTURES.find((fixture) => fixture.name === FIXTURE).raw);
	await env.BUCKET.put(RAW_KEY, raw);
	const parsed = await m.parseRawMime(raw.buffer);
	await m.storeMessageAttachments(env, "msg-a", parsed.attachments, {
		validate: false,
		...(asRaw ? { raw: { key: RAW_KEY, bytes: raw.buffer, status: "received" } } : {}),
	});
	return parsed.attachments.map((attachment) => new Uint8Array(attachment.content));
}

const rows = (database) =>
	database.db
		.prepare("SELECT * FROM message_attachments ORDER BY rowid")
		.all()
		.map((row) => ({ ...row, r2Key: row.r2_key, contentType: row.content_type }));
const columns = (database, table) =>
	database.db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.map((column) => column.name);
const storedJob = (database) =>
	database.db.prepare("SELECT attachment_storage_job AS job FROM app_settings WHERE id = 'default'").get()?.job ?? null;

/** Every attachment's bytes, in row order, read through the accessor. */
async function contents(env, database) {
	const read = [];
	for (const row of rows(database)) {
		const bytes = await m.readAttachmentBytes(env, row);
		read.push(bytes && new Uint8Array(bytes));
	}
	return read;
}

async function drain(env) {
	for (let step = 0; env.OUTBOUND_QUEUE.sent.length; step++) {
		assert.ok(step < 100, "the job kept sending batches");
		await m.processAttachmentJob(env, env.OUTBOUND_QUEUE.sent.shift().body);
	}
}

async function runJob(env, direction) {
	const answer = await m.startAttachmentJob(env, ADMIN, { direction });
	assert.ok(answer.ok, JSON.stringify(answer));
	await drain(env);
	return (await m.getAttachmentJobStatus(env)).job;
}

const exported = async (database) => JSON.parse(decoder.decode(await m.exportDatabaseRecords(database)));
const asBytes = (document) => encoder.encode(JSON.stringify(document));

const silenced = async (body) => {
	const [error, warn, info] = [console.error, console.warn, console.info];
	console.error = console.warn = console.info = () => {};
	try {
		return await body();
	} finally {
		[console.error, console.warn, console.info] = [error, warn, info];
	}
};

test("a backup from before migrations 0088 and 0090 plans inserts the current schema takes, and reclaim converges", async () => {
	const old = await setup({ skip: [STORAGE_MIGRATION, JOB_MIGRATION] });
	const expected = await deliver(old.env);
	const document = await exported(old.database);
	for (const row of document.tables.message_attachments) {
		assert.ok(!("storage" in row) && !("sha256" in row) && !("storage_checked_at" in row), "a pre-0088 row");
		assert.ok(!row.r2_key.startsWith("raw:"));
	}
	assert.ok(!("attachment_storage_job" in document.tables.app_settings[0]), "a pre-0090 settings row");

	const current = await setup({ bucket: old.bucket });
	const prepared = await m.prepareDatabaseRestore(current.database, asBytes(document));
	// The plan names the target's columns; the rows' inserts name only the columns the document has.
	const plan = prepared.tables.find((table) => table.name === "message_attachments");
	assert.deepEqual(plan.columns, columns(current.database, "message_attachments"));
	assert.equal(plan.range.rows, expected.length);
	await m.executeDatabaseRestore(current.database, prepared);

	// The new columns take their defaults: 'object' rows reclaim has not looked at, and no stored job.
	const restored = rows(current.database);
	assert.equal(restored.length, expected.length);
	for (const row of restored) {
		assert.equal(row.storage, "object");
		assert.equal(row.storage_checked_at, null);
		assert.equal(row.sha256, null);
	}
	assert.equal(storedJob(current.database), null);
	assert.equal((await m.getAttachmentJobStatus(current.env)).job, null);
	assert.deepEqual(await m.getReclaimCounts(current.env), {
		pending: { rows: expected.length, bytes: expected.reduce((sum, bytes) => sum + bytes.byteLength, 0) },
		unmatched: { rows: 0 },
	});
	assert.deepEqual(await contents(current.env, current.database), expected);

	const job = await runJob(current.env, "reclaim");
	assert.equal(job.status, "completed");
	assert.equal(job.converted, expected.length);
	assert.ok(rows(current.database).every((row) => row.storage === "raw"));
	assert.equal((await m.getReclaimCounts(current.env)).pending.rows, 0);
	assert.deepEqual((await old.bucket.list({ prefix: "attachments/" })).objects, [], "the copies are gone");
	assert.deepEqual(await contents(current.env, current.database), expected);
});

test("a stored job restored from an old backup starts nothing, and a message of the job it replaced is dropped", async () => {
	const { env, database, queue } = await setup();
	await deliver(env, { asRaw: true });
	// The backup is taken while a materialize job runs, and restored more than an hour after its last batch.
	assert.ok((await m.startAttachmentJob(env, ADMIN, { direction: "materialize" })).ok);
	queue.sent.splice(0);
	const document = await exported(database);
	const [settings] = document.tables.app_settings;
	const backedUp = JSON.parse(settings.attachment_storage_job);
	assert.equal(backedUp.status, "running");
	settings.attachment_storage_job = JSON.stringify({ ...backedUp, heartbeatAt: Date.now() - m.REVIVE_WINDOW_MS - 1 });

	// Meanwhile that job was cancelled and a reclaim started, whose first batch is still queued at the restore.
	assert.ok((await m.cancelAttachmentJob(env, ADMIN)).ok);
	assert.ok((await m.startAttachmentJob(env, ADMIN, { direction: "reclaim" })).ok);
	const inFlight = queue.sent.splice(0);
	assert.equal(inFlight.length, 1);
	const before = rows(database);

	await m.restoreDatabaseRecords(database, asBytes(document));
	assert.equal(JSON.parse(storedJob(database)).id, backedUp.id);
	await m.processAttachmentJob(env, inFlight[0].body);
	await m.runAttachmentJobMaintenance(env);
	assert.deepEqual(queue.sent, [], "neither the stale message nor the cron starts a batch");
	assert.deepEqual(rows(database), before, "no row was touched");
	const status = await m.getAttachmentJobStatus(env);
	assert.equal(status.job.id, backedUp.id);
	assert.equal(status.job.status, "interrupted");

	// Pressing the button again is what resumes it.
	const resumed = await m.startAttachmentJob(env, ADMIN, { direction: "materialize" });
	assert.ok(resumed.ok);
	assert.equal(resumed.job.id, backedUp.id);
	await drain(env);
	assert.equal((await m.getAttachmentJobStatus(env)).job.status, "completed");
	assert.equal((await m.getAttachmentStorageCounts(env)).raw.rows, 0);
});

test("a newer backup restored by an older release into a database without 0088 reads again once 0088 is applied", async () => {
	const source = await setup();
	const expected = await deliver(source.env, { asRaw: true });
	assert.ok(rows(source.database).every((row) => row.storage === "raw"));
	const document = await exported(source.database);

	// A shared object repeats a key, which the unique index before 0088 refuses: the restore fails as a whole.
	const target = await setup({ skip: [STORAGE_MIGRATION], bucket: source.bucket });
	const [first] = document.tables.message_attachments;
	const shared = { ...first, id: "att-shared", storage: "object", r2_key: "attachments/msg-a/shared/file.bin" };
	const withShared = {
		...document,
		tables: {
			...document.tables,
			message_attachments: [...document.tables.message_attachments, shared, { ...shared, id: "att-shared-2" }],
		},
	};
	await assert.rejects(m.restoreDatabaseRecords(target.database, asBytes(withShared)), /UNIQUE/);

	// Without one, the restore drops the storage columns; the rows keep their sentinel and read as not stored.
	await m.restoreDatabaseRecords(target.database, asBytes(document));
	const restored = rows(target.database);
	assert.ok(restored.every((row) => row.r2Key === `raw:${row.id}` && !("storage" in row)));
	assert.deepEqual(await contents(target.env, target.database), [null, null]);

	// Once 0088 is applied they read 'object' with no object; the first read locates the bytes in the raw again.
	assert.deepEqual(await m.applyMigrations(target.database, migrationsDir), [STORAGE_MIGRATION]);
	assert.ok(rows(target.database).every((row) => row.storage === "object" && row.raw_offset === null));
	assert.equal((await m.getAttachmentStorageCounts(target.env)).raw.rows, expected.length);
	const [lost, other] = rows(target.database);
	const opened = await silenced(() => m.openAttachment(target.env, lost, { range: { offset: 1, length: 3 } }));
	assert.deepEqual(new Uint8Array(await new Response(opened.body).arrayBuffer()), expected[0].slice(1, 4));
	const located = rows(target.database)[0];
	assert.equal(located.storage, "raw");
	assert.equal(located.raw_offset, rows(source.database)[0].raw_offset);
	assert.equal(located.sha256, rows(source.database)[0].sha256);

	// With the raw index off the second becomes an object of its own instead, never one under its sentinel.
	target.env.ATTACHMENT_RAW_INDEX = "off";
	assert.deepEqual(new Uint8Array(await silenced(() => m.readAttachmentBytes(target.env, other))), expected[1]);
	const copied = rows(target.database)[1];
	assert.equal(copied.storage, "object");
	assert.match(copied.r2Key, /^attachments\/msg-a\//);
	assert.equal(await source.bucket.get(`raw:${other.id}`), null);
	delete target.env.ATTACHMENT_RAW_INDEX;
	assert.deepEqual(await contents(target.env, target.database), expected);

	// Materialize finds such a row by its key too, so the safe state before a downgrade has none left.
	const STORAGE_COLUMNS = ["storage", "raw_offset", "raw_length", "transfer_encoding", "sha256", "storage_checked_at"];
	const older = structuredClone(document);
	for (const row of older.tables.message_attachments) for (const column of STORAGE_COLUMNS) delete row[column];
	await m.restoreDatabaseRecords(target.database, asBytes(older));
	assert.ok(rows(target.database).every((row) => row.storage === "object" && row.r2Key === `raw:${row.id}`));
	const job = await silenced(() => runJob(target.env, "materialize"));
	assert.equal(job.total, expected.length);
	assert.equal(job.converted, expected.length);
	assert.equal((await m.getAttachmentStorageCounts(target.env)).raw.rows, 0);
	assert.ok(rows(target.database).every((row) => row.storage === "object" && !row.r2Key.startsWith("raw:")));
	assert.deepEqual(await contents(target.env, target.database), expected);
});
