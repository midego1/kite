import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { loadStorageServices } from "./support/storage-services.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-backup-objects-test-");
const bucketRoot = mkdtempSync(join(tmpdir(), "kite-backup-objects-"));
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
			export { withStorage } from "./src/lib/storage/router.ts";
			export * from "./src/lib/backups/objects-utils.ts";
			export { RestoreBusyError, startStoredRestore } from "./src/lib/backups/restore.ts";
			export { processRestoreMessage } from "./src/lib/backups/restore-job.ts";
			export { parseBackupSettingsInput } from "./src/app/api/backups/utils.ts";
			export { estimateBackupObjects, markBackupObjectsPending, processBackupObjectsMessage, retryBackupObjectsCopy, startBackupObjectsRestore } from "./src/lib/backups/objects.ts";
			export { runDatabaseBackup, deleteExpiredBackups } from "./src/lib/backups/runner.ts";
			export { createBackupRecord, createScheduledBackupIfDue, deleteBackup, failStaleBackups, getBackupSettings, listBackups, updateBackupSettings } from "./src/lib/backups/service.ts";
		`,
		resolveDir: root,
		sourcefile: "backup-objects-test-entry.ts",
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
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
	plugins: [migrationStatusStub],
	logLevel: "silent",
});
const lib = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("prefixes, copy keys and manifest parts are dated and stay under backups/", () => {
	const prefix = lib.backupObjectsPrefix("bak_1", new Date("2026-10-29T02:00:00Z"));
	assert.equal(prefix, "backups/objects/2026-10-29-bak_1/");
	const deletes = (prefixToDelete) =>
		lib.isBackupObjectsMessage({ kind: "backup.objects.delete", prefix: prefixToDelete });
	assert.equal(deletes(prefix), true);
	for (const other of ["backups/objects/", "backups/objects/2026-10-29-bak_1", "backups/objects/x-bak_1/", "backups/"])
		assert.equal(deletes(other), false, other);
	assert.equal(lib.backupObjectCopyKey(prefix, "inbound/1-a.eml"), `${prefix}files/inbound/1-a.eml`);
	assert.equal(lib.backupObjectsManifestKey(prefix), `${prefix}manifest.json`);
	assert.equal(lib.backupObjectsManifestPartKey(prefix, 12), `${prefix}manifest/000012.json`);
});

test("a copy run walks every source, counts totals, numbers only parts it wrote and moves its step", () => {
	let run = lib.initialCopyRun(1);
	assert.deepEqual(run, {
		run: "copy",
		step: 1,
		source: "messages",
		after: null,
		part: 1,
		count: 0,
		size: 0,
		missing: 0,
		failed: 0,
	});
	({ next: run } = lib.advanceCopyRun(
		{ ...run, leaseUntil: 5 },
		{ lastId: "m50", exhausted: false, copied: 18, bytes: 1000, missing: 1, failed: 1 },
	));
	assert.deepEqual(run, {
		run: "copy",
		step: 2,
		source: "messages",
		after: "m50",
		part: 2,
		count: 18,
		size: 1000,
		missing: 1,
		failed: 1,
		leaseUntil: undefined,
	});
	({ next: run } = lib.advanceCopyRun(run, {
		lastId: null,
		exhausted: true,
		copied: 0,
		bytes: 0,
		missing: 0,
		failed: 0,
	}));
	assert.equal(run.source, "attachments");
	assert.equal(run.part, 2);
	({ next: run } = lib.advanceCopyRun(run, {
		lastId: "a1",
		exhausted: true,
		copied: 1,
		bytes: 10,
		missing: 0,
		failed: 0,
	}));
	assert.equal(run.source, "bodies");
	const last = lib.advanceCopyRun(run, { lastId: null, exhausted: true, copied: 0, bytes: 0, missing: 0, failed: 0 });
	assert.equal(last.done, true);
	assert.equal(last.next.count, 19);
});

test("a delivery runs its step only once, waits for a held lease and drops a step already done", () => {
	const run = { ...lib.initialCopyRun(3), leaseUntil: 2000 };
	assert.equal(lib.objectsStepAction(run, "copy", 3, 1000), "leased");
	assert.equal(lib.objectsStepAction(run, "copy", 3, 3000), "run");
	assert.equal(lib.objectsStepAction(run, "copy", 2, 3000), "done");
	assert.equal(lib.objectsStepAction(run, "restore", 3, 3000), "done");
	assert.equal(lib.objectsStepAction(null, "copy", 1, 0), "done");
	assert.equal(lib.parseObjectsRun("not json"), null);
	assert.equal(lib.parseObjectsRun(JSON.stringify(run)).step, 3);
});

test("a message stays within the subrequest budget of a consumer batch", () => {
	// Up to eight subrequests per object, five messages per consumer batch, 1,000 per invocation.
	assert.ok(lib.OBJECTS_BATCH_SIZE * 8 * 5 < 1000);
});

test("the estimate scales a sample and counts the attachments twice, once inside the raw mail", () => {
	assert.deepEqual(
		lib.estimateBackupObjectBytes({
			messages: 10,
			sample: { size: 5, bodyBytes: 2500, offloaded: 1, offloadedBytes: 150 },
			attachments: 2,
			attachmentBytes: 1000,
			rawAttachmentBytes: 1000,
		}),
		{ objects: 10 + 2 + 2, bytes: 10 * 2048 + 5000 + 1370 + 1000 + 300 },
	);
	assert.deepEqual(
		lib.estimateBackupObjectBytes({
			messages: 0,
			sample: { size: 0, bodyBytes: 0, offloaded: 0, offloadedBytes: 0 },
			attachments: 0,
			attachmentBytes: 0,
			rawAttachmentBytes: 0,
		}),
		{ objects: 0, bytes: 0 },
	);
});

test("the estimate counts 'raw' rows inside the raw mail only, never as objects of their own", () => {
	// 1,000 bytes in one object row and 3,000 bytes in 'raw' rows served from their raw messages.
	assert.deepEqual(
		lib.estimateBackupObjectBytes({
			messages: 4,
			sample: { size: 4, bodyBytes: 0, offloaded: 0, offloadedBytes: 0 },
			attachments: 1,
			attachmentBytes: 1000,
			rawAttachmentBytes: 4000,
		}),
		{ objects: 4 + 1, bytes: 4 * 2048 + 4000 * 1.37 + 1000 },
	);
});

test("the copies kept at once follow the schedule and retention", () => {
	const base = { enabled: true, scheduleType: "daily", retentionEnabled: true, retentionDays: 14 };
	assert.equal(lib.keptFullBackupCopies(base), 14);
	assert.equal(lib.keptFullBackupCopies({ ...base, scheduleType: "weekly", retentionDays: 30 }), 5);
	assert.equal(lib.keptFullBackupCopies({ ...base, scheduleType: "monthly", retentionDays: 30 }), 2);
	assert.equal(lib.keptFullBackupCopies({ ...base, enabled: false }), 1);
	assert.equal(lib.keptFullBackupCopies({ ...base, retentionEnabled: false }), null);
});

test("a stale copy or restore is judged by its heartbeat", () => {
	const now = new Date("2026-10-29T03:00:00Z");
	const at = (minutes) => new Date(now.getTime() - minutes * 60_000);
	assert.equal(lib.isStaleObjectsRun({ objectsStatus: "copying", objectsUpdatedAt: at(31) }, now), true);
	assert.equal(lib.isStaleObjectsRun({ objectsStatus: "restoring", objectsUpdatedAt: at(5) }, now), false);
	assert.equal(lib.isStaleObjectsRun({ objectsStatus: "completed", objectsUpdatedAt: at(500) }, now), false);
	assert.equal(lib.isStaleObjectsRun({ objectsStatus: "copying", objectsUpdatedAt: null }, now), true);
});

test("restore keys are checked segment by segment; bad entries are skipped and counted, repeats restored once", () => {
	const accepted = (key) => lib.parseBackupObjectsManifestPart({ objects: [{ key, size: 1 }] }).skipped === 0;
	for (const key of ["attachments/report..pdf", "inbound/1-a.eml", "bodies/msg..1.html"])
		assert.equal(accepted(key), true, key);
	for (const key of [
		"",
		"/inbound/x.eml",
		"inbound//x.eml",
		"inbound/./x.eml",
		"attachments/../backups/x",
		"backups/database/x.json",
		"drive/item",
		"avatars/u.png",
		42,
	])
		assert.equal(accepted(key), false, String(key));
	assert.deepEqual(
		lib.parseBackupObjectsManifestPart({
			objects: [
				{ key: "attachments/report..pdf", size: 3 },
				{ key: "attachments/report..pdf", size: 3 },
				{ key: "drive/item", size: 1 },
				{ key: "inbound/x.eml" },
				null,
			],
			missing: ["inbound/y.eml", 4],
			failed: ["inbound/z.eml"],
		}),
		{
			objects: [{ key: "attachments/report..pdf", size: 3 }],
			missing: ["inbound/y.eml"],
			failed: ["inbound/z.eml"],
			skipped: 3,
		},
	);
	assert.throws(() => lib.parseBackupObjectsManifestPart(null), /damaged/);
});

test("queue messages are recognised only with a step or an exact backup prefix", () => {
	assert.equal(lib.isBackupObjectsMessage({ kind: "backup.objects.copy", backupId: "b", step: 1 }), true);
	assert.equal(lib.isBackupObjectsMessage({ kind: "backup.objects.copy", backupId: "b" }), false);
	assert.equal(lib.isBackupObjectsMessage({ kind: "backup.objects.restore", backupId: "b", step: 2 }), true);
	assert.equal(
		lib.isBackupObjectsMessage({ kind: "backup.objects.delete", prefix: "backups/objects/2026-10-29-bak_x1/" }),
		true,
	);
	for (const prefix of ["backups/objects/", "backups/objects/2026-10-29-bak_x1", "inbound/", "backups/objects/../"])
		assert.equal(lib.isBackupObjectsMessage({ kind: "backup.objects.delete", prefix }), false, prefix);
	assert.equal(lib.isBackupObjectsMessage({ kind: "backup.run", backupId: "b" }), false);
});

/**
 * A migrated database, a file bucket behind the storage router and a queue that records what is sent. Keys in
 * `failing` throw when read; `puts` counts writes per key.
 */
async function fixture(t) {
	const db = new lib.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await lib.applyMigrations(db, join(root, "drizzle/migrations"));
	const queue = [];
	const files = new lib.FileBucket(mkdtempSync(join(bucketRoot, "b-")));
	const failing = new Set();
	const puts = new Map();
	const bucket = new Proxy(files, {
		get(target, property) {
			if (property === "get")
				return async (key, options) => {
					if (failing.has(key)) throw new Error("read failed");
					return target.get(key, options);
				};
			if (property === "put")
				return async (key, ...rest) => {
					puts.set(key, (puts.get(key) ?? 0) + 1);
					return target.put(key, ...rest);
				};
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const sent = [];
	const env = lib.withStorage({
		DB: db,
		BUCKET: bucket,
		OUTBOUND_QUEUE: {
			send: async (body, options) => {
				queue.push(body);
				sent.push({ body, options });
			},
		},
	});
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'alex', 'personal', 1);
	`);
	const message = db.db.prepare(
		"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, raw_r2_key, html_body_key, body_size, created_at) VALUES (?, 'owner', 'mailbox-a', 'inbound', 'a@outside.test', 'alex@example.com', 'Hi', 'Hello', 'received', ?, ?, ?, 1)",
	);
	const attachment = db.db.prepare(
		"INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES (?, ?, 'a.pdf', 'application/pdf', ?, ?, 1)",
	);
	const objects = {};
	for (let index = 0; index < 120; index++) {
		const id = `msg-${String(index).padStart(3, "0")}`;
		const raw = `inbound/${index}-raw.eml`;
		const body = index % 40 === 0 ? `bodies/${id}.html` : null;
		message.run(id, raw, body, body ? 9 : null);
		objects[raw] = `raw mail ${index}`;
		if (body) objects[body] = "<p>big</p>";
		if (index % 30 === 0) {
			const key = `attachments/${id}-report..pdf`;
			attachment.run(`att-${index}`, id, 4, key);
			objects[key] = "%PDF";
		}
	}
	// A copy of message 1 in another mailbox shares its raw object: it is copied and counted once.
	message.run("msg-zzz-copy", "inbound/1-raw.eml", null, null);
	// So does a forward that shares an attachment's object (docs/specs/attachments-once.md §5.3).
	attachment.run("att-zzz-forward", "msg-zzz-copy", 4, "attachments/msg-000-report..pdf");
	// Named by the database, gone from storage: counted as missing rather than failing the copy.
	delete objects["inbound/7-raw.eml"];
	for (const [key, value] of Object.entries(objects)) await files.put(key, value);
	db.db.exec("UPDATE backup_settings SET include_objects = 1");
	/** Delivers queued messages until the queue is empty, as the consumer would. */
	const drain = async () => {
		let delivered = 0;
		while (queue.length) {
			const body = queue.shift();
			if (body.kind === "backup.run") await lib.runDatabaseBackup(env, body.backupId);
			else if (body.kind === "backup.restore") await lib.processRestoreMessage(env, body);
			else await lib.processBackupObjectsMessage(env, body);
			delivered++;
		}
		return delivered;
	};
	return { db, env, bucket: files, queue, sent, objects, drain, failing, puts };
}

function backupRow(db, id) {
	return db.db.prepare("SELECT * FROM backups WHERE id = ?").get(id);
}

function queuedBackup(db, id) {
	db.db.exec(
		`INSERT INTO backups (id, status, \`trigger\`, created_at) VALUES ('${id}', 'queued', 'manual', unixepoch())`,
	);
}

test("a full backup copies raw mail, attachments and bodies with a manifest, and restores the missing ones", async (t) => {
	const { db, env, bucket, objects, drain } = await fixture(t);
	queuedBackup(db, "bak_full");
	await lib.runDatabaseBackup(env, "bak_full");
	assert.equal(backupRow(db, "bak_full").status, "completed", "the database part is usable at once");
	assert.equal(backupRow(db, "bak_full").objects_status, "copying");
	assert.ok((await drain()) > 3, "copied in several batches");

	const row = backupRow(db, "bak_full");
	assert.equal(row.objects_status, "completed");
	assert.equal(row.objects_count, Object.keys(objects).length);
	assert.equal(row.objects_missing, 1);
	assert.equal(row.objects_failed, 0);
	assert.equal(
		row.objects_size,
		Object.values(objects).reduce((total, value) => total + value.length, 0),
	);
	const prefix = row.objects_prefix;
	assert.match(prefix, /^backups\/objects\/\d{4}-\d{2}-\d{2}-bak_full\/$/);
	const manifest = JSON.parse(await (await bucket.get(`${prefix}manifest.json`)).text());
	assert.equal(manifest.format, "kite-backup-objects");
	assert.equal(manifest.objects, row.objects_count);
	assert.equal(manifest.missing, 1);
	assert.equal(manifest.failed, 0);
	assert.equal(manifest.database, row.r2_key);
	const parts = [];
	for (let index = 1; index <= manifest.parts; index++)
		parts.push(JSON.parse(await (await bucket.get(`${prefix}manifest/${String(index).padStart(6, "0")}.json`)).text()));
	assert.ok(parts.some((part) => part.missing.includes("inbound/7-raw.eml")));
	const listed = parts.flatMap((part) => part.objects.map((object) => object.key));
	assert.equal(new Set(listed).size, listed.length, "a shared raw or attachment object is listed once");
	assert.equal(await (await bucket.get(`${prefix}files/attachments/msg-030-report..pdf`)).text(), "%PDF");

	// Lose two objects and change one; the restore puts back what is missing and leaves the rest.
	await bucket.delete(["inbound/3-raw.eml", "attachments/msg-030-report..pdf"]);
	await bucket.put("inbound/4-raw.eml", "changed since");
	assert.equal(await lib.startBackupObjectsRestore(env, "bak_full"), "started");
	assert.equal(backupRow(db, "bak_full").objects_status, "restoring");
	await drain();
	assert.equal(backupRow(db, "bak_full").objects_status, "completed");
	assert.equal(await (await bucket.get("inbound/3-raw.eml")).text(), "raw mail 3");
	assert.equal(await (await bucket.get("attachments/msg-030-report..pdf")).text(), "%PDF");
	assert.equal(await (await bucket.get("inbound/4-raw.eml")).text(), "changed since");
	const result = JSON.parse(backupRow(db, "bak_full").objects_restore);
	assert.equal(result.restored, 2);
	assert.equal(result.present, Object.keys(objects).length - 2);
	assert.equal(result.failed, 0);

	// Deleting the backup removes its copies too, on the queue.
	assert.equal(await lib.deleteBackup(env, "bak_full"), true);
	await drain();
	assert.deepEqual((await bucket.list({ prefix: "backups/objects/" })).objects, []);
	assert.equal(await bucket.get("inbound/3-raw.eml").then((object) => object?.text()), "raw mail 3");
});

test("a restore that cannot put a file back says so instead of reporting success", async (t) => {
	const { db, env, bucket, drain } = await fixture(t);
	queuedBackup(db, "bak_partial");
	await lib.runDatabaseBackup(env, "bak_partial");
	await drain();
	const prefix = backupRow(db, "bak_partial").objects_prefix;
	await bucket.delete(["inbound/5-raw.eml", "inbound/6-raw.eml", `${prefix}files/inbound/6-raw.eml`]);
	assert.equal(await lib.startBackupObjectsRestore(env, "bak_partial"), "started");
	// A second click, or a second admin, starts nothing more.
	assert.equal(await lib.startBackupObjectsRestore(env, "bak_partial"), "busy");
	assert.equal((await drain()) > 0, true);
	const result = JSON.parse(backupRow(db, "bak_partial").objects_restore);
	assert.deepEqual([result.restored, result.failed], [1, 1]);
	assert.equal(await (await bucket.get("inbound/5-raw.eml")).text(), "raw mail 5");
});

test("objects that fail to copy are recorded, the rest copied, and Retry copies only what is missing", async (t) => {
	const { db, env, drain, failing, puts } = await fixture(t);
	failing.add("inbound/9-raw.eml");
	queuedBackup(db, "bak_retry");
	await lib.runDatabaseBackup(env, "bak_retry");
	await drain();
	let row = backupRow(db, "bak_retry");
	assert.equal(row.objects_status, "completed");
	assert.equal(row.objects_failed, 1);
	const prefix = row.objects_prefix;
	const copiedBefore = row.objects_count;

	failing.clear();
	puts.clear();
	assert.equal(await lib.retryBackupObjectsCopy(env, "bak_retry"), true);
	assert.equal(await lib.retryBackupObjectsCopy(env, "bak_retry"), false, "already copying");
	await drain();
	row = backupRow(db, "bak_retry");
	assert.equal(row.objects_status, "completed");
	assert.equal(row.objects_failed, 0);
	assert.equal(row.objects_count, copiedBefore + 1);
	const fileWrites = [...puts.keys()].filter((key) => key.startsWith(`${prefix}files/`));
	assert.deepEqual(fileWrites, [`${prefix}files/inbound/9-raw.eml`], "copies with the same size are not written again");
});

test("a duplicate or late delivery never runs a step twice, and a held step comes back after its lease", async (t) => {
	const { db, env, queue, sent, drain } = await fixture(t);
	queuedBackup(db, "bak_dup");
	await lib.runDatabaseBackup(env, "bak_dup");
	const first = queue.shift();
	assert.deepEqual(first, { kind: "backup.objects.copy", backupId: "bak_dup", step: 1 });
	await lib.processBackupObjectsMessage(env, first);
	assert.deepEqual(queue, [{ kind: "backup.objects.copy", backupId: "bak_dup", step: 2 }]);
	// The same message delivered again is for a step already done: nothing runs, nothing is queued.
	await lib.processBackupObjectsMessage(env, first);
	assert.equal(queue.length, 1);

	// Another delivery holds step 2: this one is queued again for after the lease instead of running beside it.
	const run = JSON.parse(backupRow(db, "bak_dup").objects_cursor);
	db.db
		.prepare("UPDATE backups SET objects_cursor = ? WHERE id = 'bak_dup'")
		.run(JSON.stringify({ ...run, leaseUntil: Date.now() + 60_000 }));
	const countBefore = backupRow(db, "bak_dup").objects_count;
	await lib.processBackupObjectsMessage(env, queue.shift());
	assert.equal(backupRow(db, "bak_dup").objects_count, countBefore);
	assert.equal(queue.length, 1);
	assert.ok(sent.at(-1).options.delaySeconds >= 30);

	// Once the lease ran out the step is taken over and the copy finishes.
	db.db
		.prepare("UPDATE backups SET objects_cursor = ? WHERE id = 'bak_dup'")
		.run(JSON.stringify({ ...run, leaseUntil: 1 }));
	await drain();
	assert.equal(backupRow(db, "bak_dup").objects_status, "completed");
});

test("a copy that cannot start fails alone; the database backup stays completed and is not exported again", async (t) => {
	const { db, env, sent } = await fixture(t);
	queuedBackup(db, "bak_noqueue");
	env.OUTBOUND_QUEUE.send = async () => {
		throw new Error("queue unavailable");
	};
	await lib.runDatabaseBackup(env, "bak_noqueue");
	const row = backupRow(db, "bak_noqueue");
	assert.equal(row.status, "completed");
	assert.equal(row.error, null);
	assert.equal(row.objects_status, "failed");
	const exported = row.r2_key;
	await lib.runDatabaseBackup(env, "bak_noqueue");
	assert.equal(backupRow(db, "bak_noqueue").r2_key, exported);
	assert.deepEqual(sent, []);
});

test("with the setting off a backup copies nothing; the estimate reads a sample", async (t) => {
	const { db, env, queue } = await fixture(t);
	const settings = await lib.getBackupSettings(env);
	await lib.updateBackupSettings(env, { ...settings, includeObjects: false });
	assert.equal((await lib.getBackupSettings(env)).includeObjects, false);
	queuedBackup(db, "bak_db");
	await lib.runDatabaseBackup(env, "bak_db");
	assert.equal(backupRow(db, "bak_db").objects_status, null);
	assert.deepEqual(queue, []);
	const estimate = await lib.estimateBackupObjects(env);
	assert.equal(estimate.objects, 121 + 4 + 3);
	assert.ok(estimate.bytes > 120 * 2048);
	assert.equal(await lib.startBackupObjectsRestore(env, "bak_db"), "none");
});

test("an interrupted copy is failed and resumable, an interrupted restore keeps its counts, retention waits", async (t) => {
	const { db, env, queue } = await fixture(t);
	const copying = JSON.stringify({ ...lib.initialCopyRun(4), after: "msg-040", count: 40 });
	const restoring = JSON.stringify({ run: "restore", step: 7, part: 3, restored: 5, present: 9, failed: 1 });
	db.db
		.prepare(
			`INSERT INTO backups (id, status, \`trigger\`, created_at, completed_at, objects_status, objects_prefix, objects_updated_at, objects_cursor)
			 VALUES (?, 'completed', 'scheduled', ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			"bak_copy",
			1,
			1,
			"copying",
			"backups/objects/2026-09-01-bak_copy/",
			Math.floor(Date.now() / 1000) - 3600,
			copying,
		);
	db.db
		.prepare(
			`INSERT INTO backups (id, status, \`trigger\`, created_at, completed_at, objects_status, objects_prefix, objects_updated_at, objects_cursor)
			 VALUES (?, 'completed', 'scheduled', unixepoch(), unixepoch(), 'restoring', ?, unixepoch() - 3600, ?)`,
		)
		.run("bak_restore", "backups/objects/2026-10-29-bak_restore/", restoring);
	db.db.exec(`
		INSERT INTO backups (id, status, \`trigger\`, created_at, completed_at, objects_status, objects_prefix, objects_updated_at)
		VALUES ('bak_old', 'completed', 'scheduled', 1, 1, 'restoring', 'backups/objects/2026-09-01-bak_old/', unixepoch());
		UPDATE backup_settings SET retention_enabled = 1, retention_days = 14;
	`);
	await assert.rejects(lib.deleteBackup(env, "bak_old"), /Wait until the mail files/);
	assert.equal(await lib.deleteExpiredBackups(env), 0, "runs in progress are not expired under them");
	assert.equal(await lib.failStaleBackups(env), 2);
	assert.equal(backupRow(db, "bak_copy").objects_status, "failed");
	assert.match(backupRow(db, "bak_copy").error, /interrupted/);
	const restored = backupRow(db, "bak_restore");
	assert.equal(restored.objects_status, "completed");
	assert.deepEqual(
		(({ restored: r, present, failed, interrupted }) => ({ r, present, failed, interrupted }))(
			JSON.parse(restored.objects_restore),
		),
		{ r: 5, present: 9, failed: 1, interrupted: true },
	);

	// Retry resumes where the copy stopped, under a new step.
	assert.equal(await lib.retryBackupObjectsCopy(env, "bak_copy"), true);
	const resumed = JSON.parse(backupRow(db, "bak_copy").objects_cursor);
	assert.deepEqual([resumed.after, resumed.count, resumed.step], ["msg-040", 40, 5]);
	assert.equal(backupRow(db, "bak_copy").error, null);
	assert.deepEqual(queue.splice(0), [{ kind: "backup.objects.copy", backupId: "bak_copy", step: 5 }]);
	db.db.exec("UPDATE backups SET objects_status = 'failed' WHERE id = 'bak_copy'");

	assert.equal(await lib.deleteExpiredBackups(env), 1);
	assert.equal(backupRow(db, "bak_copy"), undefined);
	assert.deepEqual(queue, [{ kind: "backup.objects.delete", prefix: "backups/objects/2026-09-01-bak_copy/" }]);
});

test("a full backup whose runner died before the copy started gets its copy from the five-minute check", async (t) => {
	const { db, env, queue, drain } = await fixture(t);
	db.db.exec(`
		INSERT INTO backups (id, status, \`trigger\`, created_at, started_at, completed_at, r2_key)
		VALUES ('bak_died', 'completed', 'scheduled', unixepoch() - 600, unixepoch() - 600, unixepoch() - 590, 'backups/database/bak_died/x.json'),
		       ('bak_fresh', 'completed', 'scheduled', unixepoch() - 30, unixepoch() - 30, unixepoch() - 20, 'backups/database/bak_fresh/x.json'),
		       ('bak_dbonly', 'completed', 'scheduled', unixepoch() - 600, unixepoch() - 600, unixepoch() - 590, 'backups/database/bak_dbonly/x.json');
	`);
	await lib.markBackupObjectsPending(env, "bak_died");
	await lib.markBackupObjectsPending(env, "bak_fresh");
	assert.equal(await lib.failStaleBackups(env), 1);
	assert.equal(backupRow(db, "bak_died").objects_status, "copying");
	assert.match(backupRow(db, "bak_died").objects_prefix, /^backups\/objects\/\d{4}-\d{2}-\d{2}-bak_died\/$/);
	assert.equal(backupRow(db, "bak_fresh").objects_status, "pending", "its runner may still be starting it");
	assert.equal(backupRow(db, "bak_dbonly").objects_status, null, "a database-only backup is never copied later");
	assert.deepEqual(queue, [{ kind: "backup.objects.copy", backupId: "bak_died", step: 1 }]);
	await drain();
	assert.equal(backupRow(db, "bak_died").objects_status, "completed");
	// A second check finds nothing more to start.
	assert.equal(await lib.failStaleBackups(env), 0);
});

test("Retry works for a copy that failed before it had a folder", async (t) => {
	const { db, env, queue, drain } = await fixture(t);
	db.db.exec(`
		INSERT INTO backups (id, status, \`trigger\`, created_at, started_at, completed_at, objects_status)
		VALUES ('bak_nostart', 'completed', 'manual', unixepoch(), unixepoch(), unixepoch(), 'failed');
	`);
	assert.equal(await lib.retryBackupObjectsCopy(env, "bak_nostart"), true);
	const row = backupRow(db, "bak_nostart");
	assert.equal(row.objects_status, "copying");
	assert.match(row.objects_prefix, /^backups\/objects\/\d{4}-\d{2}-\d{2}-bak_nostart\/$/);
	assert.deepEqual(queue, [{ kind: "backup.objects.copy", backupId: "bak_nostart", step: 1 }]);
	await drain();
	assert.equal(backupRow(db, "bak_nostart").objects_status, "completed");
});

test("restoring a full backup keeps its mail files, which can then be restored", async (t) => {
	const { db, env, bucket, drain } = await fixture(t);
	queuedBackup(db, "bak_whole");
	await lib.runDatabaseBackup(env, "bak_whole");
	// Its own document holds its row as it was while exporting: running, files pending.
	assert.equal(backupRow(db, "bak_whole").objects_status, "copying", "the copy is started right after the export");
	await drain();
	const before = backupRow(db, "bak_whole");
	assert.equal(before.objects_status, "completed");

	db.db.exec("DELETE FROM messages WHERE id = 'msg-003'");
	await bucket.delete("inbound/3-raw.eml");
	await lib.startStoredRestore(env, "bak_whole", "owner");
	await drain();
	assert.ok(db.db.prepare("SELECT id FROM messages WHERE id = 'msg-003'").get(), "the database came back");
	const after = backupRow(db, "bak_whole");
	for (const column of [
		"objects_status",
		"objects_prefix",
		"objects_count",
		"objects_size",
		"objects_missing",
		"objects_failed",
		"objects_cursor",
		"objects_restore",
		"objects_updated_at",
	])
		assert.equal(after[column], before[column], column);

	assert.equal(await lib.startBackupObjectsRestore(env, "bak_whole"), "started");
	await drain();
	assert.equal(await (await bucket.get("inbound/3-raw.eml")).text(), "raw mail 3");
	assert.equal(JSON.parse(backupRow(db, "bak_whole").objects_restore).restored, 1);
});

test("a backup whose mail files are being copied is not restored under the copy", async (t) => {
	const { db, env } = await fixture(t);
	queuedBackup(db, "bak_busy");
	await lib.runDatabaseBackup(env, "bak_busy");
	assert.equal(backupRow(db, "bak_busy").objects_status, "copying");
	await assert.rejects(lib.startStoredRestore(env, "bak_busy", "owner"), lib.RestoreBusyError);
});

/** A database migrated up to, but not including, 0081. */
async function before0081(t) {
	const migrations = join(directory, "migrations-before-0081");
	cpSync(join(root, "drizzle/migrations"), migrations, {
		recursive: true,
		filter: (source) => !source.endsWith("0081_add_backup_objects.sql"),
	});
	const db = new lib.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await lib.applyMigrations(db, migrations);
	return db;
}

const settingsRow = (db) =>
	db.db
		.prepare(
			"SELECT enabled, schedule_type, retention_enabled, retention_days FROM backup_settings WHERE id = 'default'",
		)
		.get();

test("a new install backs up daily and keeps 14 days; an existing one keeps its settings", async (t) => {
	const fresh = new lib.SqliteDatabase(":memory:");
	t.after(() => fresh.db.close());
	await lib.applyMigrations(fresh, join(root, "drizzle/migrations"));
	assert.deepEqual(settingsRow(fresh), {
		enabled: 1,
		schedule_type: "daily",
		retention_enabled: 1,
		retention_days: 14,
	});

	const existing = await before0081(t);
	existing.db.exec(
		"INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'o@example.com', 'hash', 'Owner', 1)",
	);
	const kept = settingsRow(existing);
	await lib.applyMigrations(existing, join(root, "drizzle/migrations"));
	assert.deepEqual(settingsRow(existing), kept);
	assert.equal(kept.retention_enabled, 0);
});

test("before migration 0081 backups, listing, stale checks and deletes keep working", async (t) => {
	const db = await before0081(t);
	const env = lib.withStorage({
		DB: db,
		BUCKET: new lib.FileBucket(mkdtempSync(join(bucketRoot, "old-"))),
		OUTBOUND_QUEUE: { send: async () => undefined },
	});
	assert.equal((await lib.getBackupSettings(env)).includeObjects, false);
	const settings = await lib.getBackupSettings(env);
	await lib.updateBackupSettings(env, { ...settings, retentionDays: 20, includeObjects: false });
	await assert.rejects(
		lib.updateBackupSettings(env, { ...settings, includeObjects: true }),
		/Apply pending database migrations/,
	);
	assert.equal((await lib.getBackupSettings(env)).retentionDays, 20, "the rest saved without the new column");
	// Manual and scheduled backups create their rows without naming the columns 0081 adds.
	const manual = await lib.createBackupRecord(env, "manual");
	await lib.runDatabaseBackup(env, manual);
	assert.equal(backupRow(db, manual).status, "completed");
	db.db.exec("UPDATE backup_settings SET enabled = 1, schedule_type = 'daily'");
	const scheduled = await lib.createScheduledBackupIfDue(env, new Date());
	assert.ok(scheduled);
	assert.equal(backupRow(db, scheduled).status, "queued");
	assert.equal((await lib.listBackups(env))[0].objectsStatus, null);
	assert.equal(await lib.failStaleBackups(env), 0);
	assert.equal(await lib.deleteBackup(env, manual), true);
});

test("settings input takes the mail files switch and checks schedule days", () => {
	const base = {
		enabled: true,
		scheduleType: "daily",
		retentionEnabled: true,
		retentionDays: 14,
		excludedTableGroups: [],
	};
	assert.equal(lib.parseBackupSettingsInput(base).includeObjects, false);
	assert.equal(lib.parseBackupSettingsInput({ ...base, includeObjects: true }).includeObjects, true);
	assert.equal(lib.parseBackupSettingsInput({ ...base, includeObjects: "yes" }), null);
	assert.equal(lib.parseBackupSettingsInput({ ...base, scheduleValue: 3 }).scheduleValue, null);
	assert.equal(lib.parseBackupSettingsInput({ ...base, scheduleType: "weekly", scheduleValue: 0 }).scheduleValue, 0);
	assert.equal(lib.parseBackupSettingsInput({ ...base, scheduleType: "weekly", scheduleValue: 7 }), null);
	assert.equal(lib.parseBackupSettingsInput({ ...base, scheduleType: "monthly", scheduleValue: 28 }).scheduleValue, 28);
	assert.equal(lib.parseBackupSettingsInput({ ...base, scheduleType: "monthly", scheduleValue: 0 }), null);
	assert.equal(lib.parseBackupSettingsInput({ ...base, scheduleType: "monthly", scheduleValue: 1.5 }), null);
});

const storage = await loadStorageServices("kite-backup-objects-s3-", ["kite-backups"], {
	router: "src/lib/storage/router.ts",
	objects: "src/lib/backups/objects.ts",
});

test("deleting a backup's copies reaches every store the Backups class may hold them in", async (t) => {
	const { env, db, queue } = await storage.fixture(t);
	await storage.addStore(env, "sto_backups", "kite-backups");
	const prefix = "backups/objects/2026-10-01-bak_moved/";
	// Copies made before the switch stay on the default store; later ones went to the new store.
	for (let index = 0; index < 3; index++) await env.BUCKET.put(`${prefix}files/inbound/${index}.eml`, "old");
	db.db
		.prepare(
			"INSERT INTO storage_routes (object_class, store_id, previous_store_id, updated_at) VALUES ('backups', 'sto_backups', 'default', 1)",
		)
		.run();
	storage.lib.config.clearStorageConfigCache();
	const routed = storage.lib.router.withStorage(env);
	await routed.BUCKET.put(`${prefix}manifest.json`, "{}");
	assert.ok(storage.fake.object("kite-backups", `${prefix}manifest.json`));

	await storage.lib.objects.processBackupObjectsMessage(routed, { kind: "backup.objects.delete", prefix });
	assert.equal((await env.BUCKET.list({ prefix })).objects.length, 0, "default store emptied");
	assert.equal(storage.fake.object("kite-backups", `${prefix}manifest.json`), null, "new store emptied");
	assert.deepEqual(queue, []);
});
