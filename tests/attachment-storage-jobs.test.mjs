import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { FIXTURES } from "./fixtures/mime/fixtures.mjs";

// docs/specs/attachments-once.md §8 step 5: the admin reclaim and materialize jobs, their lease and cursor, the
// un-share pass, and the convergence of a batch that died part way.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle", "migrations");
const directory = makeBundleDirectory("kite-attachment-jobs-test-");
const scratch = mkdtempSync(join(tmpdir(), "kite-attachment-jobs-"));
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
			export { readAttachmentBytes } from "./src/lib/email/attachment-storage.ts";
			export {
				getAttachmentStorageCounts,
				getReclaimCounts,
				getSharedObjectCounts,
				verifyAttachmentObjects,
			} from "./src/lib/email/attachment-storage-report.ts";
			export { copyMessageAttachments, storeMessageAttachments } from "./src/lib/email/attachments.ts";
			export { parseRawMime } from "./src/lib/email/parse.ts";
			export { isRawBackedMessage, rawBackedMessagesSql } from "./src/lib/email/attachment-storage-utils.ts";
			export {
				cancelAttachmentJob,
				getAttachmentJobStatus,
				processAttachmentJob,
				runAttachmentJobMaintenance,
				startAttachmentJob,
				AttachmentJobsUnavailableError,
			} from "./src/lib/email/attachment-storage-jobs.ts";
			export * as utils from "./src/lib/email/attachment-storage-jobs-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "attachment-jobs-test-entry.ts",
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
const { utils } = m;

const encoder = new TextEncoder();
let counter = 0;
const ADMIN = { id: "owner" };

/** The repository's migrations without `skipped`, so a database can be left a release behind. */
function migrationsWithout(skipped) {
	if (!skipped.length) return migrationsDir;
	const copy = join(scratch, `migrations-${++counter}`);
	mkdirSync(copy, { recursive: true });
	for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql") && !skipped.includes(file)))
		copyFileSync(join(migrationsDir, name), join(copy, name));
	return copy;
}

/** A queue that keeps what was sent, so a test runs the job's batches itself. */
function fakeQueue() {
	const sent = [];
	return { sent, send: async (body, options) => void sent.push({ body, delaySeconds: options?.delaySeconds }) };
}

async function setup({ skip = [] } = {}) {
	const database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, migrationsWithout(skip));
	const message = (id, status, rawKey) =>
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at)
			VALUES ('${id}', 'owner', 'mailbox-a', 'inbound', 'sender@example.com', 'support@example.com', 'Fixture', '${status}', ${rawKey ? `'${rawKey}'` : "NULL"}, 1);`;
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'support', 1);
		${message("msg-a", "received", "inbound/1-a.eml")}
		${message("msg-b", "received", "inbound/2-b.eml")}
		${message("msg-c", "archived", "imports/c.eml")}
		${message("msg-draft", "draft", null)}
		${message("msg-sent", "sent", null)}
	`);
	const bucket = new m.FileBucket(join(scratch, `bucket-${++counter}`));
	const queue = fakeQueue();
	return { database, bucket, queue, env: { DB: database, BUCKET: bucket, OUTBOUND_QUEUE: queue } };
}

const fixtureRaw = (name) => encoder.encode(FIXTURES.find((fixture) => fixture.name === name).raw);
const bytesOf = (value) => new Uint8Array(value);
const rows = (database) =>
	database.db
		.prepare(
			"SELECT id, message_id AS messageId, storage, r2_key AS r2Key, size, content_type AS contentType, storage_checked_at AS checkedAt FROM message_attachments ORDER BY message_id, rowid",
		)
		.all();
const jobOf = (database) =>
	JSON.parse(database.db.prepare("SELECT attachment_storage_job AS job FROM app_settings").get()?.job ?? "null");
async function objectKeys(bucket) {
	const listed = await bucket.list({ prefix: "attachments/" });
	return listed.objects.map((object) => object.key).sort();
}

/** Stores a fixture's raw and its attachments, as objects (`asRaw` false: mail from before the reclaim) or 'raw' rows. */
async function deliver(env, messageId, rawKey, fixture, { asRaw = false } = {}) {
	const raw = fixtureRaw(fixture);
	await env.BUCKET.put(rawKey, raw);
	const parsed = await m.parseRawMime(raw.buffer);
	await m.storeMessageAttachments(env, messageId, parsed.attachments, {
		validate: false,
		...(asRaw ? { raw: { key: rawKey, bytes: raw.buffer, status: "received" } } : {}),
	});
	return parsed;
}

/** Every attachment's bytes, by id, read through the accessor. */
async function contents(env, database) {
	const read = new Map();
	for (const row of rows(database)) read.set(row.id, bytesOf(await m.readAttachmentBytes(env, row)));
	return read;
}

/** Runs queued batches until none is left (delays are ignored; a lease a test leaves held must be cleared first). */
async function drain(env, limit = 200) {
	for (let step = 0; env.OUTBOUND_QUEUE.sent.length; step++) {
		assert.ok(step < limit, "the job kept sending batches");
		const { body } = env.OUTBOUND_QUEUE.sent.shift();
		await m.processAttachmentJob(env, body);
	}
}

async function run(env, direction, extra = {}) {
	const answer = await m.startAttachmentJob(env, ADMIN, { direction, ...extra });
	assert.ok(answer.ok, JSON.stringify(answer));
	await drain(env);
	return jobOf(env.DB);
}

const silenced = async (body) => {
	const [error, warn] = [console.error, console.warn];
	console.error = console.warn = () => {};
	try {
		return await body();
	} finally {
		[console.error, console.warn] = [error, warn];
	}
};

test("utils: messages, stored jobs and the lease", () => {
	assert.ok(utils.isAttachmentStorageJobMessage({ kind: "attachments.storage", jobId: "asj_1", batch: 0 }));
	assert.ok(!utils.isAttachmentStorageJobMessage({ kind: "attachments.storage", jobId: "asj_1", batch: -1 }));
	assert.ok(!utils.isAttachmentStorageJobMessage({ kind: "storage.migrate", jobId: "asj_1", batch: 0 }));
	assert.ok(!utils.isAttachmentStorageJobMessage(null));
	const now = 1_000_000;
	const job = utils.newJob({ id: "asj_1", direction: "materialize", startedBy: "owner", total: 3, now });
	assert.equal(job.phase, "materialize");
	assert.deepEqual(utils.parseJob(JSON.stringify(job)), job);
	assert.equal(utils.parseJob("{not json"), null);
	assert.equal(utils.parseJob(JSON.stringify({ ...job, direction: "sideways" })), null);
	assert.equal(utils.parseJob(JSON.stringify({ ...job, done: "many" })), null);
	assert.equal(utils.parseJob(null), null);

	const claimed = utils.claimedJob({ ...job, testCrashAfter: 2 }, now);
	assert.equal(claimed.testCrashAfter, undefined, "a re-run of a crashed batch does not crash again");
	assert.ok(utils.isLeased(claimed, now + utils.LEASE_MS - 1));
	assert.ok(utils.isActive(claimed, now + utils.LEASE_MS - 1));
	assert.equal(utils.leaseWaitSeconds(claimed, now), utils.LEASE_MS / 1000 + 1);
	const later = now + utils.LEASE_MS + utils.STALL_MS;
	assert.ok(!utils.isActive(claimed, later) && utils.isStalled(claimed, later));
	assert.ok(utils.shouldRevive(claimed, later));
	assert.ok(!utils.shouldRevive(claimed, now + utils.REVIVE_WINDOW_MS + 1), "an old restored job is not revived");
	assert.ok(!utils.isActive({ ...job, status: "completed" }, now));
	assert.equal(utils.jobView(claimed, later).status, "interrupted");
	assert.equal(utils.jobView(claimed, now).status, "running");

	const resumed = utils.resumedJob({ ...claimed, cursor: "att_9", done: 7 }, later);
	assert.deepEqual([resumed.cursor, resumed.done, resumed.batch, resumed.leaseUntil], ["att_9", 7, 1, undefined]);
	assert.ok(utils.areTestHooksEnabled("1", "development"));
	assert.ok(!utils.areTestHooksEnabled("1", "production"));
	assert.ok(!utils.areTestHooksEnabled(undefined, "development"));
});

test("utils: phases, failures and the batch budget", () => {
	const now = 5_000;
	const job = utils.claimedJob(
		utils.newJob({ id: "asj_2", direction: "materialize", startedBy: null, total: 2, now }),
		now,
	);
	const partial = { ...utils.emptyBatch(null), cursor: "att_1", done: 1, converted: 1 };
	const moved = utils.finishedBatch(job, partial, now + 1);
	assert.deepEqual(
		[moved.phase, moved.cursor, moved.batch, moved.leaseUntil, moved.done],
		["materialize", "att_1", 1, undefined, 1],
	);
	const unshare = utils.finishedBatch(moved, { ...partial, cursor: "att_2", exhausted: true }, now + 2, 4);
	assert.deepEqual([unshare.phase, unshare.cursor, unshare.total, unshare.status], ["unshare", null, 6, "running"]);
	const done = utils.finishedBatch(unshare, { ...utils.emptyBatch(null), exhausted: true }, now + 3);
	assert.deepEqual([done.status, done.finishedAt], ["completed", now + 3]);
	const reclaim = utils.newJob({ id: "asj_3", direction: "reclaim", startedBy: null, total: 0, now });
	assert.equal(utils.finishedBatch(reclaim, { ...utils.emptyBatch(null), exhausted: true }, now).status, "completed");

	let failing = job;
	for (let attempt = 1; attempt < utils.MAX_BATCH_FAILURES; attempt++)
		failing = utils.failedBatch(failing, "D1 down", now);
	assert.equal(failing.status, "running");
	assert.equal(utils.failedBatch(failing, "D1 down", now).status, "failed");

	const cost = (item) => ({ bytes: item, operations: 1 });
	assert.deepEqual(utils.takeWithinBudget([500, 1], cost, { items: 5, bytes: 100, operations: 10 }), [500]);
	assert.deepEqual(utils.takeWithinBudget([40, 40, 40], cost, { items: 5, bytes: 100, operations: 10 }), [40, 40]);
	assert.deepEqual(utils.takeWithinBudget([1, 1, 1], cost, { items: 2, bytes: 100, operations: 10 }), [1, 1]);
	assert.deepEqual(utils.takeWithinBudget([1, 1, 1], cost, { items: 5, bytes: 100, operations: 2 }), [1, 1]);
	assert.ok(utils.reclaimCost({ rows: 2, bytes: 100 }).bytes > 200);
	assert.ok(utils.materializeCost({ size: 100 }).bytes > 100);
	assert.equal(utils.unshareCost({ size: 100 }).bytes, 200);
});

test("the raw-backed SQL agrees with isRawBackedMessage", async () => {
	const { database } = await setup();
	database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at) VALUES
			('msg-jmap', 'owner', 'mailbox-a', 'outbound', 'a@example.com', 'b@example.com', 'x', 'draft', 'drafts/x.eml', 1),
			('msg-synced', 'owner', 'mailbox-a', 'inbound', 'a@example.com', 'b@example.com', 'x', 'received', 'external/a/1/2.eml', 1),
			('msg-indraft', 'owner', 'mailbox-a', 'inbound', 'a@example.com', 'b@example.com', 'x', 'draft', 'inbound/9.eml', 1)`);
	const all = database.db.prepare("SELECT id, status, raw_r2_key AS rawKey FROM messages").all();
	const matched = new Set(
		database.db
			.prepare(`SELECT id FROM messages m WHERE ${m.rawBackedMessagesSql("m")}`)
			.all()
			.map((row) => row.id),
	);
	for (const message of all) assert.equal(matched.has(message.id), m.isRawBackedMessage(message), message.id);
	assert.deepEqual([...matched].sort(), ["msg-a", "msg-b", "msg-c"]);
});

test("reclaim turns verified object rows into 'raw' rows, keeps shared objects, and a second run does nothing", async () => {
	const { env, database, bucket } = await setup();
	const parsedA = await deliver(env, "msg-a", "inbound/1-a.eml", "multipart/mixed");
	await deliver(env, "msg-c", "imports/c.eml", "related inside alternative inside mixed, with an inline cid image");
	await deliver(env, "msg-b", "inbound/2-b.eml", "quoted-printable and uuencode attachments");
	// A forward draft made before the job shares msg-a's object.
	await m.copyMessageAttachments(env, "msg-a", "msg-draft");
	const before = await contents(env, database);
	const pending = (await m.getReclaimCounts(env)).pending.rows;
	assert.ok(pending >= 4);

	const job = await run(env, "reclaim");
	assert.equal(job.status, "completed");
	assert.equal(job.total, pending);
	const after = rows(database);
	const of = (messageId) => after.filter((row) => row.messageId === messageId);
	assert.ok([...of("msg-a"), ...of("msg-c")].every((row) => row.storage === "raw" && row.r2Key === `raw:${row.id}`));
	assert.ok(
		of("msg-b").every((row) => row.storage === "object" && row.checkedAt),
		"unverifiable rows stay objects",
	);
	assert.ok(
		of("msg-draft").every((row) => row.storage === "object"),
		"a draft is never raw-backed",
	);
	assert.equal(job.converted, of("msg-a").length + of("msg-c").length);
	assert.equal(job.unmatched, of("msg-b").length);
	// The forward's object survives; msg-c's objects, which nothing else named, are gone.
	assert.deepEqual(
		await objectKeys(bucket),
		[...new Set([...of("msg-draft"), ...of("msg-b")].map((row) => row.r2Key))].sort(),
	);
	assert.deepEqual(await contents(env, database), before);
	assert.deepEqual(bytesOf(await m.readAttachmentBytes(env, of("msg-a")[0])), bytesOf(parsedA.attachments[0].content));
	assert.equal((await m.verifyAttachmentObjects(env)).missing.length, 0);
	assert.deepEqual((await m.getReclaimCounts(env)).pending, { rows: 0, bytes: 0 });

	const snapshot = [rows(database), await objectKeys(bucket)];
	const again = await run(env, "reclaim");
	assert.deepEqual([again.status, again.done, again.converted, again.total], ["completed", 0, 0, 0]);
	assert.deepEqual([rows(database), await objectKeys(bucket)], snapshot);
});

test("materialize gives raw rows objects and shared rows their own copies; reclaim then converges back", async () => {
	const { env, database, bucket } = await setup();
	await deliver(env, "msg-a", "inbound/1-a.eml", "multipart/mixed", { asRaw: true });
	await deliver(env, "msg-c", "imports/c.eml", "two identical attachments", { asRaw: true });
	await deliver(env, "msg-b", "inbound/2-b.eml", "quoted-printable and uuencode attachments", { asRaw: true });
	// msg-b's object rows are shared by a draft and by the message sent from it.
	await m.copyMessageAttachments(env, "msg-b", "msg-draft");
	await m.copyMessageAttachments(env, "msg-draft", "msg-sent");
	const before = await contents(env, database);
	const rawRows = rows(database).filter((row) => row.storage === "raw").length;
	assert.ok(rawRows >= 3);
	const shared = await m.getSharedObjectCounts(env);
	assert.ok(shared.keys >= 1 && shared.rows === 2 * shared.keys);

	const job = await run(env, "materialize");
	assert.deepEqual(
		[job.status, job.phase, job.converted, job.unshared],
		["completed", "unshare", rawRows, shared.rows],
	);
	assert.equal(job.total, rawRows + shared.rows);
	const materialized = rows(database);
	assert.ok(materialized.every((row) => row.storage === "object" && !row.r2Key.startsWith("raw:")));
	assert.equal(new Set(materialized.map((row) => row.r2Key)).size, materialized.length, "no row shares an object");
	assert.deepEqual(await m.getSharedObjectCounts(env), { keys: 0, rows: 0 });
	assert.deepEqual(await objectKeys(bucket), materialized.map((row) => row.r2Key).sort());
	assert.deepEqual(await contents(env, database), before);
	assert.equal((await m.verifyAttachmentObjects(env)).missing.length, 0);
	// Materialized rows are reclaim's to look at again.
	assert.ok(materialized.every((row) => row.checkedAt === null || row.messageId === "msg-b"));

	const back = await run(env, "reclaim");
	assert.equal(back.status, "completed");
	const reclaimed = rows(database);
	assert.equal(reclaimed.filter((row) => row.storage === "raw").length, rawRows);
	assert.deepEqual(
		await objectKeys(bucket),
		reclaimed
			.filter((row) => row.storage === "object")
			.map((row) => row.r2Key)
			.sort(),
		"the materialized objects are gone, the copies of unverifiable and draft rows stay",
	);
	assert.deepEqual(await contents(env, database), before);
	assert.equal((await m.verifyAttachmentObjects(env)).missing.length, 0);
});

test("a batch that dies part way leaves its lease, waits it out and converges without orphans", async () => {
	const { env, database, bucket, queue } = await setup();
	await deliver(env, "msg-a", "inbound/1-a.eml", "related inside alternative inside mixed, with an inline cid image", {
		asRaw: true,
	});
	await deliver(env, "msg-c", "imports/c.eml", "two identical attachments", { asRaw: true });
	const before = await contents(env, database);
	env.ATTACHMENT_STORAGE_TEST_HOOKS = "1";
	const started = await m.startAttachmentJob(env, ADMIN, { direction: "materialize", testCrashAfter: 2 });
	assert.ok(started.ok);
	const [first] = queue.sent.splice(0);
	await assert.rejects(m.processAttachmentJob(env, first.body), /Simulated crash/);
	const crashed = jobOf(database);
	assert.equal(crashed.cursor, null, "a killed batch never moved the cursor");
	assert.ok(crashed.leaseUntil > Date.now() && crashed.testCrashAfter === undefined);
	assert.equal(rows(database).filter((row) => row.storage === "object").length, 2, "two rows were done before it died");

	// The queue delivers the message again: the lease is still held, so it comes back once the lease runs out.
	await m.processAttachmentJob(env, first.body);
	assert.equal(queue.sent.length, 1);
	assert.ok(queue.sent[0].delaySeconds > 1);
	// A start meanwhile is refused.
	assert.equal((await m.startAttachmentJob(env, ADMIN, { direction: "materialize" })).code, "JOB_RUNNING");
	database.db
		.prepare("UPDATE app_settings SET attachment_storage_job = ?")
		.run(JSON.stringify({ ...crashed, leaseUntil: Date.now() - 1 }));
	await drain(env);
	const job = jobOf(database);
	assert.equal(job.status, "completed");
	const materialized = rows(database);
	assert.ok(materialized.every((row) => row.storage === "object"));
	assert.deepEqual(await objectKeys(bucket), materialized.map((row) => row.r2Key).sort(), "no orphaned objects");
	assert.deepEqual(await contents(env, database), before);
});

test("stale messages are dropped, cancel stops the job, and a stopped job resumes from its cursor", async () => {
	const { env, database, queue } = await setup();
	await deliver(env, "msg-a", "inbound/1-a.eml", "multipart/mixed", { asRaw: true });
	await deliver(env, "msg-c", "imports/c.eml", "two identical attachments", { asRaw: true });
	const started = await m.startAttachmentJob(env, ADMIN, { direction: "materialize" });
	const [message] = queue.sent.splice(0);
	await m.processAttachmentJob(env, { ...message.body, batch: 7 });
	await m.processAttachmentJob(env, { ...message.body, jobId: "asj_other" });
	assert.equal(jobOf(database).batch, 0, "messages for another batch or job change nothing");
	assert.equal(queue.sent.length, 0);

	assert.ok((await m.cancelAttachmentJob(env, ADMIN)).ok);
	await m.processAttachmentJob(env, message.body);
	assert.equal(jobOf(database).status, "cancelled");
	assert.ok(
		rows(database).every((row) => row.storage === "raw"),
		"a cancelled job runs no batch",
	);
	assert.equal((await m.cancelAttachmentJob(env, ADMIN)).code, "NO_JOB");
	const audit = database.db.prepare("SELECT action FROM audit_logs ORDER BY rowid").all();
	assert.deepEqual(
		audit.map((row) => row.action),
		["attachments.storage_job_started", "attachments.storage_job_cancelled"],
	);

	// A job whose batches stopped arriving resumes from its cursor and counters.
	const stalled = {
		...jobOf(database),
		status: "running",
		cursor: rows(database)[0].id,
		done: 1,
		heartbeatAt: Date.now() - utils.STALL_MS - 1,
	};
	database.db.prepare("UPDATE app_settings SET attachment_storage_job = ?").run(JSON.stringify(stalled));
	assert.equal((await m.getAttachmentJobStatus(env)).job.status, "interrupted");
	const resumed = await m.startAttachmentJob(env, ADMIN, { direction: "materialize" });
	assert.ok(resumed.ok);
	assert.deepEqual([resumed.job.id, resumed.job.done], [started.job.id, 1]);
	await drain(env);
	const done = jobOf(database);
	assert.equal(done.status, "completed");
	assert.equal(rows(database)[0].storage, "raw", "the row before the cursor was not looked at again");
	assert.ok(
		rows(database)
			.slice(1)
			.every((row) => row.storage === "object"),
	);
});

test("the cron sends a stopped job's batch again within the hour", async () => {
	const { env, database, queue } = await setup();
	await deliver(env, "msg-a", "inbound/1-a.eml", "multipart/mixed", { asRaw: true });
	await m.startAttachmentJob(env, ADMIN, { direction: "materialize" });
	queue.sent.splice(0);
	await m.runAttachmentJobMaintenance(env);
	assert.equal(queue.sent.length, 0, "a running job is left alone");
	const job = jobOf(database);
	await m.runAttachmentJobMaintenance(env, new Date(job.heartbeatAt + utils.STALL_MS + 1));
	assert.equal(queue.sent.length, 1);
	assert.equal(queue.sent[0].body.batch, job.batch + 1);
	await drain(env);
	assert.equal(jobOf(database).status, "completed");
	await m.runAttachmentJobMaintenance(env, new Date(Date.now() + utils.STALL_MS + 1));
	assert.equal(queue.sent.length, 0, "a finished job is never revived");
});

test("reclaim is refused and stops while ATTACHMENT_RAW_INDEX is off", async () => {
	const { env, database, queue } = await setup();
	await deliver(env, "msg-a", "inbound/1-a.eml", "multipart/mixed");
	env.ATTACHMENT_RAW_INDEX = "off";
	assert.equal((await m.startAttachmentJob(env, ADMIN, { direction: "reclaim" })).code, "RAW_INDEX_OFF");
	assert.deepEqual((await m.getAttachmentJobStatus(env)).switches, { rawIndex: false, sharing: true });
	env.ATTACHMENT_RAW_INDEX = "on";
	assert.ok((await m.startAttachmentJob(env, ADMIN, { direction: "reclaim" })).ok);
	env.ATTACHMENT_RAW_INDEX = "off";
	await silenced(() => drain(env));
	const job = jobOf(database);
	assert.deepEqual([job.status, job.stopReason], ["cancelled", "raw_index_off"]);
	assert.ok(rows(database).every((row) => row.storage === "object"));
	assert.equal(queue.sent.length, 0);
});

test("materialize leaves a row whose raw message is gone, and repoints nothing a concurrent change already moved", async () => {
	const { env, database, bucket } = await setup();
	await deliver(env, "msg-a", "inbound/1-a.eml", "multipart/mixed", { asRaw: true });
	await deliver(env, "msg-c", "imports/c.eml", "multipart/mixed", { asRaw: true });
	await bucket.delete("imports/c.eml");
	// A delete of msg-a lands while its object is being written: the copy must not stay behind.
	const put = bucket.put.bind(bucket);
	bucket.put = async (key, ...rest) => {
		const written = await put(key, ...rest);
		if (key.startsWith("attachments/msg-a/")) database.db.exec("DELETE FROM messages WHERE id = 'msg-a'");
		return written;
	};
	const job = await silenced(() => run(env, "materialize"));
	assert.equal(job.status, "completed");
	assert.equal(job.failed, 1);
	assert.match(job.lastError, /raw message is missing/);
	assert.deepEqual(
		rows(database).map((row) => [row.messageId, row.storage]),
		[["msg-c", "raw"]],
	);
	assert.deepEqual(await objectKeys(bucket), [], "the copy written for the deleted row was removed");
});

test("un-share leaves a row alone that was repointed while its copy was written", async () => {
	const { env, database, bucket } = await setup();
	await deliver(env, "msg-b", "inbound/2-b.eml", "quoted-printable and uuencode attachments");
	await m.copyMessageAttachments(env, "msg-b", "msg-draft");
	const [draftRow] = rows(database).filter((row) => row.messageId === "msg-draft");
	const put = bucket.put.bind(bucket);
	bucket.put = async (key, ...rest) => {
		const written = await put(key, ...rest);
		if (key === `attachments/msg-draft/${draftRow.id}`)
			database.db
				.prepare("UPDATE message_attachments SET r2_key = 'attachments/elsewhere' WHERE id = ?")
				.run(draftRow.id);
		return written;
	};
	await run(env, "materialize");
	assert.equal(rows(database).find((row) => row.id === draftRow.id).r2Key, "attachments/elsewhere");
	assert.ok(!(await objectKeys(bucket)).includes(`attachments/msg-draft/${draftRow.id}`));
});

test("reclaim repairs a row whose object is gone instead of failing it", async () => {
	const { env, database, bucket } = await setup();
	const parsed = await deliver(env, "msg-a", "inbound/1-a.eml", "multipart/mixed");
	const [row] = rows(database);
	await bucket.delete(row.r2Key);
	const job = await silenced(() => run(env, "reclaim"));
	assert.deepEqual([job.converted, job.failed], [1, 0]);
	assert.equal(rows(database)[0].storage, "raw");
	assert.deepEqual(
		bytesOf(await m.readAttachmentBytes(env, rows(database)[0])),
		bytesOf(parsed.attachments[0].content),
	);
	// A message whose raw is gone is looked at once and left alone.
	const { env: other, database: otherDb, bucket: otherBucket } = await setup();
	await deliver(other, "msg-a", "inbound/1-a.eml", "multipart/mixed");
	await otherBucket.delete("inbound/1-a.eml");
	const lost = await run(other, "reclaim");
	assert.deepEqual([lost.failed, lost.converted], [1, 0]);
	assert.ok(rows(otherDb).every((entry) => entry.storage === "object" && entry.checkedAt));
});

test("before migrations 0088 and 0090 the jobs answer that the update is pending", async () => {
	const behind = await setup({ skip: ["0090_add_attachment_storage_job.sql"] });
	assert.deepEqual((await m.getAttachmentJobStatus(behind.env)).jobsReady, false);
	await assert.rejects(
		m.startAttachmentJob(behind.env, ADMIN, { direction: "materialize" }),
		m.AttachmentJobsUnavailableError,
	);
	await m.processAttachmentJob(behind.env, { kind: "attachments.storage", jobId: "asj_1", batch: 0 });
	await m.runAttachmentJobMaintenance(behind.env);
	const older = await setup({ skip: ["0088_attachment_raw_storage.sql", "0090_add_attachment_storage_job.sql"] });
	assert.equal((await m.startAttachmentJob(older.env, ADMIN, { direction: "materialize" })).code, "MIGRATION_PENDING");
	assert.equal(await m.getReclaimCounts(older.env), null);
});
