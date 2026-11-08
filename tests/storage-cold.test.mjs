import assert from "node:assert/strict";
import test from "node:test";
import { loadStorageServices } from "./support/storage-services.mjs";

const { lib, fake, fixture, addStore } = await loadStorageServices(
	"kite-storage-cold-",
	["kite-target", "kite-target-2"],
	{
		cold: "src/lib/storage/cold.ts",
		router: "src/lib/storage/router.ts",
	},
);
const { cold, router: routerLib } = lib;
const { clearStorageConfigCache } = lib.config;

const DAY = 24 * 60 * 60;
const NOW = 1_700_000_000;

async function addMessage(env, id, { body = `raw ${id}`, createdAt = NOW - 60 * DAY, attachments = [] } = {}) {
	const rawKey = `inbound/${id}.eml`;
	env.DB.db
		.prepare(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at)
			 VALUES (?, 'owner', 'mailbox-a', 'inbound', 'sender@example.net', 'a@example.com', 'Hello', 'received', ?, ?)`,
		)
		.run(id, rawKey, createdAt);
	await env.BUCKET.put(rawKey, body, { httpMetadata: { contentType: "message/rfc822" } });
	for (const [index, content] of attachments.entries()) {
		const key = `attachments/${id}/${index}`;
		env.DB.db
			.prepare(
				`INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at)
				 VALUES (?, ?, ?, 'text/plain', ?, ?, ?)`,
			)
			.run(`${id}-att-${index}`, id, `file-${index}.txt`, content.length, key, createdAt);
		await env.BUCKET.put(key, content);
	}
	return rawKey;
}

async function addBackup(env, id, { size = 2048, createdAt = NOW - 60 * DAY, status = "completed" } = {}) {
	const key = `backups/database/${id}.json`;
	env.DB.db
		.prepare(
			`INSERT INTO backups (id, status, trigger, r2_key, filename, size, created_at) VALUES (?, ?, 'manual', ?, ?, ?, ?)`,
		)
		.run(id, status, key, `${id}.json`, size, createdAt);
	await env.BUCKET.put(key, "x".repeat(size));
	return key;
}

async function addDriveFile(env, id, content, { storeId = "default", createdAt = NOW - 60 * DAY } = {}) {
	env.DB.db
		.prepare(
			`INSERT INTO drive_items (id, owner_id, kind, name, size, store_id, object_key, status, created_at, updated_at)
			 VALUES (?, 'owner', 'file', ?, ?, ?, ?, 'ready', ?, ?)`,
		)
		.run(id, `${id}.txt`, content.length, storeId, `drive/${id}`, createdAt, createdAt);
	await env.BUCKET.put(`drive/${id}`, content);
}

async function setColdRule(env, objectClass, { afterDays = 30, minBytes = 0, target, enabled = true } = {}) {
	const result = await cold.updateColdRule(env, "owner", objectClass, { afterDays, minBytes, target, enabled });
	assert.equal(result.ok, true, result.ok ? undefined : result.error);
}

/** Delivers queued cold batches until the sweep stops re-enqueueing itself, or `limit` batches ran. */
async function drain(env, queue, limit = 200) {
	let batches = 0;
	while (queue.length && batches < limit) {
		const { message } = queue.shift();
		await cold.processStorageQueueMessage(env, message);
		batches += 1;
	}
	return batches;
}

const job = (env, objectClass) =>
	env.DB.db.prepare("SELECT * FROM storage_cold_jobs WHERE object_class = ?").get(objectClass);
const location = (env, key) => env.DB.db.prepare("SELECT * FROM object_locations WHERE key = ?").get(key);
const target = () => fake.buckets.get("kite-target").objects;

test("a mail sweep moves only objects at or past the age cutoff to the target store, verified and recorded", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { attachments: ["attachment bytes"], createdAt: NOW - 60 * DAY });
	await addMessage(env, "young", { createdAt: NOW - 1 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "mail").status, "completed");
	assert.equal(job(env, "mail").errors, 0);
	assert.equal(await env.BUCKET.get("inbound/old.eml"), null, "deleted from the source once confirmed on the target");
	assert.equal(await (await env.BUCKET.get("inbound/young.eml")).text(), "raw young", "too young to move");
	assert.equal(Buffer.from(target().get("inbound/old.eml").bytes).toString("utf8"), "raw old");
	assert.equal(Buffer.from(target().get("attachments/old/0").bytes).toString("utf8"), "attachment bytes");
	const loc = location(env, "inbound/old.eml");
	assert.equal(loc.store_id, "sto_target");
	assert.equal(loc.storage_class, null);
	assert.equal(location(env, "inbound/young.eml"), undefined);
});

test("opening a moved message needs no extra step: the router falls back to object_locations on a miss", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	const routed = routerLib.createStorageRouter(env);
	const read = await routed.get("inbound/old.eml");
	assert.equal(await read.text(), "raw old", "read through the router, no caller-visible change");
});

test("re-running a completed sweep moves nothing twice", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	const bytesFirst = job(env, "mail").bytes_done;
	assert.ok(bytesFirst > 0);
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "mail").bytes_done, 0, "the second pass finds nothing left to move");
});

test("a sweep resumes from its cursor across batches, and the maintenance cron restarts a stalled one", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	for (let index = 0; index < 55; index += 1)
		await addMessage(env, `m${String(index).padStart(3, "0")}`, { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	assert.equal(queue.length, 1);
	const { message } = queue.shift();
	await cold.processStorageQueueMessage(env, message);
	assert.equal(job(env, "mail").objects_done, 50);
	assert.equal(queue.length, 1, "the next batch is queued");
	await drain(env, queue);
	assert.equal(job(env, "mail").status, "completed");
	assert.equal(target().size, 55);

	// A batch that never finished (a lost message, a deploy): its lease expired and no later batch landed.
	const leased = JSON.parse(job(env, "mail").cursor);
	env.DB.db
		.prepare(
			"UPDATE storage_cold_jobs SET status = 'running', finished_at = NULL, cursor = ? WHERE object_class = 'mail'",
		)
		.run(JSON.stringify({ ...leased, leaseUntil: Date.now() - 60_000, lastBatchAt: Date.now() - 10 * 60_000 }));
	assert.equal(queue.length, 0);
	await cold.runStorageColdMaintenance(env, new Date());
	assert.equal(queue.length, 1, "the stalled sweep is resent");
});

test("a backups rule only moves completed backups at or above the size floor", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addBackup(env, "small", { size: 100, createdAt: NOW - 60 * DAY });
	await addBackup(env, "big", { size: 4096, createdAt: NOW - 60 * DAY });
	await addBackup(env, "queued", { size: 4096, createdAt: NOW - 60 * DAY, status: "queued" });
	await setColdRule(env, "backups", { afterDays: 30, minBytes: 1024, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(target().has("backups/database/big.json"), true);
	assert.equal(target().has("backups/database/small.json"), false, "under the size floor");
	assert.equal(target().has("backups/database/queued.json"), false, "not completed");
});

test("a drive rule moves old files through the Drive hooks, updating each row's store and clearing its storage class", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addDriveFile(env, "drv_old", "alpha", { createdAt: NOW - 60 * DAY });
	await addDriveFile(env, "drv_young", "bravo", { createdAt: NOW - 1 * DAY });
	await setColdRule(env, "drive", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "drive").status, "completed");
	const rows = env.DB.db.prepare("SELECT id, store_id, storage_class FROM drive_items ORDER BY id").all();
	assert.deepEqual(rows, [
		{ id: "drv_old", store_id: "sto_target", storage_class: null },
		{ id: "drv_young", store_id: "default", storage_class: null },
	]);
	assert.equal(Buffer.from(target().get("drive/drv_old").bytes).toString("utf8"), "alpha");
	assert.equal(await env.BUCKET.get("drive/drv_old"), null);
});

test("an r2-ia rule rewrites a file in place when the store supports it, and skips quietly when it does not", async (t) => {
	const { env, queue } = await fixture(t);
	await addDriveFile(env, "drv_old", "alpha", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "drive", { afterDays: 30, target: "r2-ia" });

	// The Node file bucket (KITE_RUNTIME "node") has no storage classes, so a rewrite has nothing to do.
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "drive").status, "completed");
	assert.equal(
		env.DB.db.prepare("SELECT storage_class FROM drive_items WHERE id = 'drv_old'").get().storage_class,
		null,
	);

	// On Workers, the default store reports Infrequent Access.
	env.KITE_RUNTIME = "workers";
	clearStorageConfigCache();
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "drive").status, "completed");
	assert.equal(
		env.DB.db.prepare("SELECT storage_class FROM drive_items WHERE id = 'drv_old'").get().storage_class,
		"InfrequentAccess",
	);
	assert.equal(await (await env.BUCKET.get("drive/drv_old")).text(), "alpha");
});

test("a disabled or missing rule leaves every store untouched", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	assert.equal(queue.length, 0);
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target", enabled: false });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	assert.equal(queue.length, 0);
	assert.equal(job(env, "mail"), undefined);
});

test("changing a rule's target still finds an object a previous sweep already moved, through object_locations", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addStore(env, "sto_target2", "kite-target-2");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(target().has("inbound/old.eml"), true);
	assert.equal(location(env, "inbound/old.eml").store_id, "sto_target");

	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target2" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "mail").status, "completed");
	assert.equal(job(env, "mail").errors, 0);
	assert.equal(target().has("inbound/old.eml"), false, "moved on from the first target store");
	assert.equal(
		Buffer.from(fake.buckets.get("kite-target-2").objects.get("inbound/old.eml").bytes).toString("utf8"),
		"raw old",
	);
	assert.equal(location(env, "inbound/old.eml").store_id, "sto_target2");
});
