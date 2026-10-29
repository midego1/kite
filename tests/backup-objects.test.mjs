import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-backup-objects-test-");
const bucketRoot = mkdtempSync(join(tmpdir(), "kite-backup-objects-"));
after(() => {
	rmSync(directory, { recursive: true, force: true });
	rmSync(bucketRoot, { recursive: true, force: true });
});
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { FileBucket } from "./server/runtime/file-bucket.ts";
			export { withStorage } from "./src/lib/storage/router.ts";
			export * from "./src/lib/backups/objects-utils.ts";
			export { parseBackupSettingsInput } from "./src/app/api/backups/utils.ts";
			export { estimateBackupObjects, processBackupObjectsMessage, startBackupObjectsRestore } from "./src/lib/backups/objects.ts";
			export { runDatabaseBackup, deleteExpiredBackups } from "./src/lib/backups/runner.ts";
			export { deleteBackup, failStaleBackups, getBackupSettings, listBackups, updateBackupSettings } from "./src/lib/backups/service.ts";
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
	logLevel: "silent",
});
const lib = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("prefixes, copy keys and manifest parts are dated and stay under backups/", () => {
	const prefix = lib.backupObjectsPrefix("bak_1", new Date("2026-10-29T02:00:00Z"));
	assert.equal(prefix, "backups/objects/2026-10-29-bak_1/");
	assert.equal(lib.backupObjectCopyKey(prefix, "inbound/1-a.eml"), `${prefix}files/inbound/1-a.eml`);
	assert.equal(lib.backupObjectsManifestKey(prefix), `${prefix}manifest.json`);
	assert.equal(lib.backupObjectsManifestPartKey(prefix, 12), `${prefix}manifest/000012.json`);
});

test("the cursor walks every source, counts totals and only numbers parts it wrote", () => {
	let cursor = lib.initialBackupObjectsCursor();
	assert.deepEqual(cursor, { source: "messages", after: null, part: 1, count: 0, size: 0, missing: 0 });
	cursor = lib.advanceBackupObjectsCursor(cursor, {
		lastId: "m50",
		exhausted: false,
		copied: 49,
		bytes: 1000,
		missing: 1,
	});
	assert.deepEqual(cursor, { source: "messages", after: "m50", part: 2, count: 49, size: 1000, missing: 1 });
	cursor = lib.advanceBackupObjectsCursor(cursor, { lastId: null, exhausted: true, copied: 0, bytes: 0, missing: 0 });
	assert.deepEqual(cursor, { source: "attachments", after: null, part: 2, count: 49, size: 1000, missing: 1 });
	cursor = lib.advanceBackupObjectsCursor(cursor, { lastId: "a1", exhausted: true, copied: 1, bytes: 10, missing: 0 });
	assert.equal(cursor.source, "bodies");
	assert.equal(cursor.part, 3);
	assert.equal(
		lib.advanceBackupObjectsCursor(cursor, { lastId: null, exhausted: true, copied: 0, bytes: 0, missing: 0 }),
		null,
	);
});

test("the estimate counts the attachments twice, once inside the raw mail", () => {
	assert.deepEqual(
		lib.estimateBackupObjectBytes({
			messages: 10,
			bodyBytes: 5000,
			attachments: 2,
			attachmentBytes: 1000,
			offloadedBodies: 1,
			offloadedBodyBytes: 300,
		}),
		{ objects: 13, bytes: 10 * 2048 + 5000 + 1370 + 1000 + 300 },
	);
});

test("a stale copy or restore is judged by its heartbeat", () => {
	const now = new Date("2026-10-29T03:00:00Z");
	const at = (minutes) => new Date(now.getTime() - minutes * 60_000);
	assert.equal(lib.isStaleObjectsRun({ objectsStatus: "copying", objectsUpdatedAt: at(31) }, now), true);
	assert.equal(lib.isStaleObjectsRun({ objectsStatus: "restoring", objectsUpdatedAt: at(5) }, now), false);
	assert.equal(lib.isStaleObjectsRun({ objectsStatus: "completed", objectsUpdatedAt: at(500) }, now), false);
	assert.equal(lib.isStaleObjectsRun({ objectsStatus: "copying", objectsUpdatedAt: null }, now), true);
});

test("manifest parts only name mail objects, and queue messages are recognised", () => {
	assert.deepEqual(
		lib.parseBackupObjectsManifestPart({ objects: [{ key: "attachments/a", size: 3 }], missing: ["inbound/x.eml", 4] }),
		{ objects: [{ key: "attachments/a", size: 3 }], missing: ["inbound/x.eml"] },
	);
	for (const key of ["backups/database/x.json", "drive/item", "avatars/u.png", "attachments/../backups/x"])
		assert.throws(() => lib.parseBackupObjectsManifestPart({ objects: [{ key, size: 1 }] }), /not mail|damaged/);
	assert.throws(() => lib.parseBackupObjectsManifestPart(null), /damaged/);
	assert.equal(lib.isBackupObjectsMessage({ kind: "backup.objects.copy", backupId: "b", cursor: {} }), true);
	assert.equal(lib.isBackupObjectsMessage({ kind: "backup.objects.delete", prefix: "backups/objects/x/" }), true);
	assert.equal(lib.isBackupObjectsMessage({ kind: "backup.objects.delete", prefix: "inbound/" }), false);
	assert.equal(lib.isBackupObjectsMessage({ kind: "backup.run", backupId: "b" }), false);
});

/** A migrated database, a file bucket behind the storage router and a queue that records what is sent. */
async function fixture(t) {
	const db = new lib.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await lib.applyMigrations(db, join(root, "drizzle/migrations"));
	const queue = [];
	const bucket = new lib.FileBucket(mkdtempSync(join(bucketRoot, "b-")));
	const env = lib.withStorage({ DB: db, BUCKET: bucket, OUTBOUND_QUEUE: { send: async (body) => queue.push(body) } });
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
			const key = `attachments/${id}-a.pdf`;
			attachment.run(`att-${index}`, id, 4, key);
			objects[key] = "%PDF";
		}
	}
	// Named by the database, gone from storage: counted as missing rather than failing the copy.
	delete objects["inbound/7-raw.eml"];
	for (const [key, value] of Object.entries(objects)) await bucket.put(key, value);
	db.db.exec("UPDATE backup_settings SET include_objects = 1");
	/** Delivers queued messages until the queue is empty, as the consumer would. */
	const drain = async () => {
		let delivered = 0;
		while (queue.length) {
			const body = queue.shift();
			if (body.kind === "backup.run") await lib.runDatabaseBackup(env, body.backupId);
			else await lib.processBackupObjectsMessage(env, body);
			delivered++;
		}
		return delivered;
	};
	return { db, env, bucket, queue, objects, drain };
}

function backupRow(db, id) {
	return db.db.prepare("SELECT * FROM backups WHERE id = ?").get(id);
}

test("a full backup copies raw mail, attachments and bodies with a manifest, and restores the missing ones", async (t) => {
	const { db, env, bucket, objects, drain } = await fixture(t);
	db.db.exec(
		"INSERT INTO backups (id, status, `trigger`, created_at) VALUES ('bak_full', 'queued', 'manual', unixepoch())",
	);
	await lib.runDatabaseBackup(env, "bak_full");
	assert.equal(backupRow(db, "bak_full").status, "completed", "the database part is usable at once");
	assert.equal(backupRow(db, "bak_full").objects_status, "copying");
	assert.ok((await drain()) > 3, "copied in several batches");

	const row = backupRow(db, "bak_full");
	assert.equal(row.objects_status, "completed");
	assert.equal(row.objects_count, Object.keys(objects).length);
	assert.equal(row.objects_missing, 1);
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
	assert.equal(manifest.database, row.r2_key);
	const part = JSON.parse(await (await bucket.get(`${prefix}manifest/000001.json`)).text());
	assert.ok(part.missing.includes("inbound/7-raw.eml"));
	assert.equal(await (await bucket.get(`${prefix}files/attachments/msg-030-a.pdf`)).text(), "%PDF");

	// Lose two objects and change one; the restore puts back what is missing and leaves the rest.
	await bucket.delete(["inbound/3-raw.eml", "bodies/msg-040.html"]);
	await bucket.put("inbound/4-raw.eml", "changed since");
	assert.equal(await lib.startBackupObjectsRestore(env, "bak_full"), true);
	assert.equal(backupRow(db, "bak_full").objects_status, "restoring");
	await drain();
	assert.equal(backupRow(db, "bak_full").objects_status, "completed");
	assert.equal(await (await bucket.get("inbound/3-raw.eml")).text(), "raw mail 3");
	assert.equal(await (await bucket.get("bodies/msg-040.html")).text(), "<p>big</p>");
	assert.equal(await (await bucket.get("inbound/4-raw.eml")).text(), "changed since");

	// Deleting the backup removes its copies too, on the queue.
	assert.equal(await lib.deleteBackup(env, "bak_full"), true);
	await drain();
	assert.deepEqual((await bucket.list({ prefix: "backups/objects/" })).objects, []);
	assert.equal(await bucket.get("inbound/3-raw.eml").then((object) => object?.text()), "raw mail 3");
});

test("with the setting off a backup copies nothing, and the estimate is shown from the database", async (t) => {
	const { db, env, queue } = await fixture(t);
	const settings = await lib.getBackupSettings(env);
	await lib.updateBackupSettings(env, { ...settings, includeObjects: false });
	assert.equal((await lib.getBackupSettings(env)).includeObjects, false);
	db.db.exec(
		"INSERT INTO backups (id, status, `trigger`, created_at) VALUES ('bak_db', 'queued', 'manual', unixepoch())",
	);
	await lib.runDatabaseBackup(env, "bak_db");
	assert.equal(backupRow(db, "bak_db").objects_status, null);
	assert.deepEqual(queue, []);
	const estimate = await lib.estimateBackupObjects(env);
	assert.equal(estimate.objects, 120 + 4 + 3);
	assert.ok(estimate.bytes > 120 * 2048);
	assert.equal(await lib.startBackupObjectsRestore(env, "bak_db"), false);
});

test("an interrupted copy is failed, an interrupted restore can start again, and retention keeps running ones", async (t) => {
	const { db, env, queue } = await fixture(t);
	db.db.exec(`
		INSERT INTO backups (id, status, \`trigger\`, created_at, completed_at, objects_status, objects_prefix, objects_updated_at)
		VALUES ('bak_copy', 'completed', 'scheduled', unixepoch() - 86400 * 40, unixepoch() - 86400 * 40, 'copying', 'backups/objects/x-bak_copy/', unixepoch() - 3600),
		       ('bak_restore', 'completed', 'scheduled', unixepoch(), unixepoch(), 'restoring', 'backups/objects/x-bak_restore/', unixepoch() - 3600),
		       ('bak_old', 'completed', 'scheduled', unixepoch() - 86400 * 40, unixepoch() - 86400 * 40, 'restoring', 'backups/objects/x-bak_old/', unixepoch());
		UPDATE backup_settings SET retention_enabled = 1, retention_days = 14;
	`);
	await assert.rejects(lib.deleteBackup(env, "bak_old"), /Wait until the mail files/);
	assert.equal(await lib.deleteExpiredBackups(env), 0, "a restore in progress is not expired under it");
	assert.equal(await lib.failStaleBackups(env), 2);
	assert.equal(backupRow(db, "bak_copy").objects_status, "failed");
	assert.match(backupRow(db, "bak_copy").error, /interrupted/);
	assert.equal(backupRow(db, "bak_restore").objects_status, "completed");
	assert.equal(await lib.deleteExpiredBackups(env), 1);
	assert.equal(backupRow(db, "bak_copy"), undefined);
	assert.deepEqual(queue, [{ kind: "backup.objects.delete", prefix: "backups/objects/x-bak_copy/" }]);
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
	db.db.exec(
		"INSERT INTO backups (id, status, `trigger`, created_at) VALUES ('bak_old', 'queued', 'manual', unixepoch())",
	);
	await lib.runDatabaseBackup(env, "bak_old");
	assert.equal(backupRow(db, "bak_old").status, "completed");
	assert.equal((await lib.listBackups(env))[0].objectsStatus, null);
	assert.equal(await lib.failStaleBackups(env), 0);
	assert.equal(await lib.deleteBackup(env, "bak_old"), true);
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
