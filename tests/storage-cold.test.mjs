import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore } from "./support/module-database.mjs";
import { APP_ORIGIN, loadStorageServices } from "./support/storage-services.mjs";

const { lib, fake, fixture, addStore } = await loadStorageServices(
	"kite-storage-cold-",
	["kite-target", "kite-target-2"],
	{
		cold: "src/lib/storage/cold.ts",
		router: "src/lib/storage/router.ts",
		storageIndex: "src/lib/storage/index.ts",
		objectLocations: "src/lib/storage/object-locations.ts",
	},
);
const { cold, router: routerLib } = lib;
const { clearStorageConfigCache } = lib.config;
const { getStorage } = lib.storageIndex;
const { recordObjectLocation } = lib.objectLocations;

const schemaScratch = makeBundleDirectory("kite-storage-cold-schema-");
after(() => rmSync(schemaScratch, { recursive: true, force: true }));
const beforeColdStorage = copyMigrationsBefore(schemaScratch, 97);
const beforeOrphanTracking = copyMigrationsBefore(schemaScratch, 103);

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
	// The real shape (`BACKUP_PREFIX/<id>/<filename>`, `src/lib/backups/utils.ts`): the liveness check in
	// `cold.ts`'s `stillReferenced` derives the backup id from this, so the fixture must match it exactly.
	const key = `backups/database/${id}/${id}.json`;
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
	const storage = await getStorage(env);
	await storage.store(storeId).bucket.put(`drive/${id}`, content);
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
const orphan = (env, key, storeId) =>
	storeId
		? env.DB.db.prepare("SELECT * FROM storage_cold_orphans WHERE key = ? AND store_id = ?").get(key, storeId)
		: env.DB.db.prepare("SELECT * FROM storage_cold_orphans WHERE key = ?").get(key);
const target = () => fake.buckets.get("kite-target").objects;
/** Past the orphan sweep's 7-day grace period. */
const GRACE_PERIOD_DAY = 8;

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
	assert.equal(target().has("backups/database/big/big.json"), true);
	assert.equal(target().has("backups/database/small/small.json"), false, "under the size floor");
	assert.equal(target().has("backups/database/queued/queued.json"), false, "not completed");
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

test("deleting a cold-moved key reaches the store object_locations names, and clears the row", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(target().has("inbound/old.eml"), true);
	assert.ok(location(env, "inbound/old.eml"), "recorded, outside the mail class's normal chain");

	// Trash emptied, retention, account deletion and deleteBackup all go through env.BUCKET.delete; it must
	// reach a key a cold move parked outside the class chain, not just leave it there forever.
	const routed = routerLib.createStorageRouter(env);
	await routed.delete("inbound/old.eml");
	assert.equal(target().has("inbound/old.eml"), false, "reached through object_locations, not just the class chain");
	assert.equal(location(env, "inbound/old.eml"), undefined, "dropped, so it never blocks deleting that store");
});

test("a cold move whose location record was lost still finds the object at the rule's target, and self-heals", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(target().has("inbound/old.eml"), true);
	assert.ok(location(env, "inbound/old.eml"));

	// Simulates a crash between confirming the copy on the target store and recording its location: the
	// object already lives only on the target store (the source was already deleted), but nothing points to
	// it in the database yet.
	env.DB.db.prepare("DELETE FROM object_locations WHERE key = 'inbound/old.eml'").run();
	env.DB.db.prepare("DELETE FROM storage_cold_jobs WHERE object_class = 'mail'").run();

	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "mail").status, "completed");
	assert.equal(job(env, "mail").errors, 0, "found directly at the rule's target instead of erroring as missing");
	assert.equal(location(env, "inbound/old.eml").store_id, "sto_target", "the record is restored");
});

test("a drive cold move marks the row before deleting the old copy: a failed delete leaves the row already correct", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_source", "kite-target");
	await addStore(env, "sto_target", "kite-target-2");
	await addDriveFile(env, "drv_old", "alpha", { storeId: "sto_source", createdAt: NOW - 60 * DAY });
	await setColdRule(env, "drive", { afterDays: 30, target: "sto_target" });

	// The copy, its verification and the row's own repoint all land before the old copy is deleted; if that
	// last step fails (here, simulated), the row must already be correct, not a crash away from pointing at a
	// store that no longer has the file.
	fake.state.denied.add("DeleteObject");
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "drive").errors, 1);
	assert.equal(
		env.DB.db.prepare("SELECT store_id, storage_class FROM drive_items WHERE id = 'drv_old'").get().store_id,
		"sto_target",
		"already repointed to where the file actually is",
	);
	assert.ok(fake.buckets.get("kite-target-2").objects.has("drive/drv_old"), "copied to the new store");
	assert.ok(
		fake.buckets.get("kite-target").objects.has("drive/drv_old"),
		"the old copy is merely left behind, not lost",
	);
});

test("a failing default store does not stop a cold-moved key from being read through object_locations", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(target().has("inbound/old.eml"), true);

	// The default store (the normal chain's only member here, since mail's route was never switched) now
	// fails every read: a transient outage must not keep the fallback to object_locations from running.
	const realBucket = env.BUCKET;
	env.BUCKET = new Proxy(realBucket, {
		get(target, property) {
			if (property === "get" || property === "head")
				return () => {
					throw new Error("simulated default store outage");
				};
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	const routed = routerLib.createStorageRouter(env);
	const read = await routed.get("inbound/old.eml");
	assert.equal(await read.text(), "raw old", "still found on the cold target despite the outage");
	const headed = await routed.head("inbound/old.eml");
	assert.ok(headed);

	// A key that truly is not anywhere still surfaces the real error, not a silent miss.
	await assert.rejects(routed.get("inbound/nowhere.eml"), /simulated default store outage/);
});

test("deleting a key whose store cannot be reached right now keeps the location record instead of losing track of it", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.ok(location(env, "inbound/old.eml"));

	// The store is now blocked (a bad endpoint, a revoked credential): built.store(storeId) finds nothing.
	env.DB.db.prepare("UPDATE storage_stores SET endpoint = 'http://blocked.invalid' WHERE id = 'sto_target'").run();
	clearStorageConfigCache();

	const routed = routerLib.createStorageRouter(env);
	await routed.delete("inbound/old.eml");
	assert.ok(
		location(env, "inbound/old.eml"),
		"kept, since nothing actually deleted the object this store still (unreachably) holds",
	);
});

test("a Drive row a restore rewound to its old store still finds the file through object_locations, and repairs the row", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addDriveFile(env, "drv_old", "alpha", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "drive", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(env.DB.db.prepare("SELECT store_id FROM drive_items WHERE id = 'drv_old'").get().store_id, "sto_target");
	assert.ok(location(env, "drive/drv_old"), "the drive move is also recorded in object_locations");

	// What restoring an older backup does: the row is rewound to the store the file no longer has it on (the
	// backup predates the cold move, and the current default store never had this file to begin with).
	env.DB.db.prepare("UPDATE drive_items SET store_id = 'default' WHERE id = 'drv_old'").run();

	const item = env.DB.db.prepare("SELECT * FROM drive_items WHERE id = 'drv_old'").get();
	const request = new Request("https://kite.test/api/drive/files/drv_old/content");
	const response = await lib.driveContent.streamDriveFile(
		env,
		request,
		{
			id: item.id,
			kind: item.kind,
			status: item.status,
			objectKey: item.object_key,
			storeId: item.store_id,
			size: item.size,
			name: item.name,
			contentType: "text/plain",
			updatedAt: new Date(item.updated_at * 1000),
		},
		false,
	);
	assert.equal(response.status, 200, "found through object_locations despite the rewound row");
	assert.equal(await response.text(), "alpha");

	// Self-healed: a later read does not need the fallback again.
	assert.equal(env.DB.db.prepare("SELECT store_id FROM drive_items WHERE id = 'drv_old'").get().store_id, "sto_target");
});

test("a Drive cold sweep that lands on a row a restore rewound repairs it through object_locations instead of failing", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addDriveFile(env, "drv_old", "alpha", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "drive", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(env.DB.db.prepare("SELECT store_id FROM drive_items WHERE id = 'drv_old'").get().store_id, "sto_target");
	assert.equal(target().has("drive/drv_old"), true);

	// What restoring an older backup does: the row is rewound to a store that no longer has the file (the sweep
	// already moved it away), the same starting point as `streamDriveFile`'s own fallback above, but this time
	// hit by a later cold sweep re-considering the row, not a read.
	env.DB.db.prepare("UPDATE drive_items SET store_id = 'default' WHERE id = 'drv_old'").run();

	// Restarts the (already completed) sweep from scratch, so it reconsiders every file again, including one
	// whose row now looks like it was never moved.
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);

	assert.equal(job(env, "drive").errors, 0, job(env, "drive").last_error);
	assert.equal(
		env.DB.db.prepare("SELECT store_id FROM drive_items WHERE id = 'drv_old'").get().store_id,
		"sto_target",
		"repaired instead of left pointing at a store that does not have the file",
	);
	assert.equal(target().has("drive/drv_old"), true, "the file itself was never touched, only the row");
	assert.equal(Buffer.from(target().get("drive/drv_old").bytes).toString("utf8"), "alpha", "and still reads back fine");
});

test("a batch's progress write only lands while its claim is still the job's current cursor", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	assert.equal(queue.length, 1);
	const { message } = queue.shift();

	// A legitimate batch: claims, moves the one eligible message, and writes its progress.
	await cold.processStorageQueueMessage(env, message);
	const afterFirstBatch = job(env, "mail").cursor;
	assert.equal(JSON.parse(afterFirstBatch).sources.messages, "done", "the messages source really did advance");

	// Simulates a worker whose own claim (back when the cursor still read "nothing done yet") finally finishes
	// and tries to write its progress only after another delivery already moved the job past that point: the
	// exact UPDATE processColdBatch uses, bound to the stale cursor a slow worker would still be holding.
	const stale = JSON.stringify({
		...JSON.parse(afterFirstBatch),
		sources: { messages: null, attachments: null, bodies: null },
	});
	const result = env.DB.db
		.prepare(
			`UPDATE storage_cold_jobs SET cursor = ?, objects_done = objects_done + 1
			 WHERE object_class = 'mail' AND status NOT IN ('failed') AND cursor = ?`,
		)
		.run(JSON.stringify({ sources: { messages: "stale-worker-wrote-this" } }), stale);
	assert.equal(result.changes, 0, "the stale worker's write is rejected, not applied on top of the real progress");
	assert.equal(job(env, "mail").cursor, afterFirstBatch, "the real progress is untouched");
});

test("the five-minute maintenance marks an unreferenced cold copy a candidate, then deletes it only once the grace period has passed", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.ok(location(env, "inbound/old.eml"));
	assert.equal(target().has("inbound/old.eml"), true);

	// A message deleted between a mover copying its raw mail and recording the location (or a race between
	// two movers that leaves an unrecorded copy behind) ends up exactly here: a location nothing references.
	env.DB.db.prepare("DELETE FROM messages WHERE id = 'old'").run();

	await cold.runStorageColdMaintenance(env, new Date(NOW * 1000));
	assert.equal(target().has("inbound/old.eml"), true, "never deleted on first sighting");
	assert.ok(location(env, "inbound/old.eml"), "the location survives being marked a candidate");
	assert.ok(orphan(env, "inbound/old.eml", "sto_target"), "recorded as an orphan candidate");

	// Immediately again: still within the grace period, so still untouched.
	await cold.runStorageColdMaintenance(env, new Date((NOW + 1) * 1000));
	assert.equal(target().has("inbound/old.eml"), true);

	// Well past the grace period: the delete pass re-checks the reference (still gone) and removes it.
	await cold.runStorageColdMaintenance(env, new Date((NOW + GRACE_PERIOD_DAY * DAY) * 1000));
	assert.equal(target().has("inbound/old.eml"), false, "the orphaned copy itself is deleted");
	assert.equal(location(env, "inbound/old.eml"), undefined, "and its record with it");
	assert.equal(orphan(env, "inbound/old.eml", "sto_target"), undefined, "and the candidate row");
});

test("a candidate that became referenced again before its grace period is un-marked instead of deleted", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	env.DB.db.prepare("DELETE FROM messages WHERE id = 'old'").run();
	await cold.runStorageColdMaintenance(env, new Date(NOW * 1000));
	assert.ok(orphan(env, "inbound/old.eml", "sto_target"), "recorded as an orphan candidate");

	// A restore (or anything else) brings the message back before the grace period is up.
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });

	await cold.runStorageColdMaintenance(env, new Date((NOW + GRACE_PERIOD_DAY * DAY) * 1000));
	assert.equal(target().has("inbound/old.eml"), true, "the copy is kept: it is referenced again");
	assert.ok(location(env, "inbound/old.eml"));
	assert.equal(orphan(env, "inbound/old.eml", "sto_target"), undefined, "no longer a candidate");
});

test("a candidate that is not the current location waits for the current store to actually have a readable copy before it is deleted", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_old", "kite-target");
	await addStore(env, "sto_new", "kite-target-2");
	const key = "inbound/old.eml";
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });

	// The candidate's own copy (from an earlier cold move) still physically exists on sto_old...
	fake.buckets.get("kite-target").objects.set(key, {
		bytes: Buffer.from("the candidate's copy"),
		meta: { custom: {} },
		etag: "e1",
		lastModified: new Date(),
	});
	env.DB.db
		.prepare(
			"INSERT INTO storage_cold_orphans (id, store_id, key, object_class, moved_at, orphaned_at) VALUES ('sco_test', 'sto_old', ?, 'mail', ?, ?)",
		)
		.run(key, NOW - 60 * DAY, NOW - GRACE_PERIOD_DAY * DAY);
	// ...while a new mover already recorded the key as belonging to sto_new (between its own HEAD and the
	// write actually landing there, the race `L2` is about), so `object_locations` already points elsewhere,
	// the key is still referenced (the message row), but sto_new does not actually have a readable copy yet.
	env.DB.db
		.prepare(
			"INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES (?, 'mail', 'sto_new', NULL, 10, ?)",
		)
		.run(key, NOW);

	await cold.runStorageColdMaintenance(env, new Date(NOW * 1000));
	assert.equal(target().has(key), true, "not deleted: sto_new cannot actually be read yet");
	assert.ok(orphan(env, key, "sto_old"), "the candidate is deferred, not forgotten");
	assert.equal(location(env, key).store_id, "sto_new", "untouched either way");

	// The new mover's write lands for real.
	fake.buckets.get("kite-target-2").objects.set(key, {
		bytes: Buffer.from("the new mover's copy"),
		meta: { custom: {} },
		etag: "e2",
		lastModified: new Date(),
	});

	// The deferral above reset this candidate's own grace-period clock, so it needs a full grace period again.
	await cold.runStorageColdMaintenance(env, new Date((NOW + GRACE_PERIOD_DAY * DAY) * 1000));
	assert.equal(target().has(key), false, "now safe to delete: another readable copy was confirmed first");
	assert.equal(orphan(env, key, "sto_old"), undefined);
	assert.equal(location(env, key).store_id, "sto_new", "the current location is never touched");
	assert.equal(
		fake.buckets.get("kite-target-2").objects.has(key),
		true,
		"the new mover's copy is never the one touched",
	);
});

test("the maintenance leaves an orphan's record alone while its store cannot be reached, for a later retry", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	env.DB.db.prepare("DELETE FROM messages WHERE id = 'old'").run();
	await cold.runStorageColdMaintenance(env, new Date(NOW * 1000));
	assert.ok(orphan(env, "inbound/old.eml", "sto_target"));

	// The store is now blocked (a bad endpoint, a revoked credential): built.store(storeId) finds nothing.
	env.DB.db.prepare("UPDATE storage_stores SET endpoint = 'http://blocked.invalid' WHERE id = 'sto_target'").run();
	clearStorageConfigCache();

	await cold.runStorageColdMaintenance(env, new Date((NOW + GRACE_PERIOD_DAY * DAY) * 1000));
	assert.ok(location(env, "inbound/old.eml"), "kept for a retry once the store is reachable again");
	assert.ok(orphan(env, "inbound/old.eml", "sto_target"), "the candidate stays recorded too");
});

test("candidates stuck on a blocked store, filling a whole delete batch, do not permanently hold up a healthy one behind them", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_healthy", "kite-target");
	await addStore(env, "sto_blocked", "kite-target-2");
	const orphanRow = env.DB.db.prepare(
		"INSERT INTO storage_cold_orphans (id, store_id, key, object_class, moved_at, orphaned_at) VALUES (?, ?, ?, 'mail', ?, ?)",
	);
	const pastGrace = NOW - GRACE_PERIOD_DAY * DAY;
	const healthyKey = "inbound/healthy.eml";
	fake.buckets.get("kite-target").objects.set(healthyKey, {
		bytes: Buffer.from("a perfectly healthy copy"),
		meta: { custom: {} },
		etag: "eh",
		lastModified: new Date(),
	});
	// Just barely past its own grace period: the newest (least overdue) candidate of all of them.
	orphanRow.run("sco_healthy", "sto_healthy", healthyKey, pastGrace, pastGrace);
	// A full delete batch's worth of candidates on a blocked store, every one of them older than the healthy
	// one, so without something pushing a deferred candidate out of the front of the queue, the healthy one
	// behind them would never even be selected by `ORDER BY orphaned_at LIMIT 200`, no matter how many runs.
	for (let index = 0; index < 200; index++) {
		const key = `inbound/blocked-${String(index).padStart(3, "0")}.eml`;
		fake.buckets.get("kite-target-2").objects.set(key, {
			bytes: Buffer.from(`stuck behind a blocked store ${index}`),
			meta: { custom: {} },
			etag: `eb${index}`,
			lastModified: new Date(),
		});
		orphanRow.run(`sco_blocked_${index}`, "sto_blocked", key, pastGrace - 100_000 - index, pastGrace - 100_000 - index);
	}
	env.DB.db.prepare("UPDATE storage_stores SET endpoint = 'http://blocked.invalid' WHERE id = 'sto_blocked'").run();
	clearStorageConfigCache();

	// First run: the batch is entirely the 200 blocked candidates (all older than the healthy one), every one
	// deferred. A second run at the very same moment proves they were pushed to the back of the queue rather
	// than left exactly where they were: if they had not moved, this query would pick the same 200 again, for
	// as many runs as it is tried, and the healthy one would never come up.
	await cold.runStorageColdMaintenance(env, new Date(NOW * 1000));
	await cold.runStorageColdMaintenance(env, new Date(NOW * 1000));

	assert.equal(fake.buckets.get("kite-target").objects.has(healthyKey), false, "the healthy copy got its turn");
	assert.equal(orphan(env, healthyKey, "sto_healthy"), undefined);
	assert.equal(
		fake.buckets.get("kite-target-2").objects.size,
		200,
		"every blocked copy is kept, not lost, just deferred",
	);
	assert.equal(
		env.DB.db.prepare("SELECT COUNT(*) AS n FROM storage_cold_orphans WHERE store_id = 'sto_blocked'").get().n,
		200,
	);
});

test("the maintenance never touches a cold copy a live message still names", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);

	await cold.runStorageColdMaintenance(env, new Date((NOW + GRACE_PERIOD_DAY * DAY) * 1000));
	assert.ok(location(env, "inbound/old.eml"));
	assert.equal(target().has("inbound/old.eml"), true);
	assert.equal(orphan(env, "inbound/old.eml", "sto_target"), undefined, "never even marked a candidate");
});

test("the maintenance skips entirely while a restore is running, so it never marks every cold key unreferenced", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	// A restore's "deletes" segment empties messages before writing them back; object_locations (a merge
	// table) is untouched, so a run landing in that window would otherwise see every cold key as unreferenced.
	env.DB.db.prepare("DELETE FROM messages WHERE id = 'old'").run();
	await env.BUCKET.put(
		"system/backup-restore.json",
		JSON.stringify({
			version: 1,
			id: "rst_1",
			status: "restoring",
			seq: 1,
			lease: null,
			userId: null,
			createdAt: new Date(NOW * 1000).toISOString(),
			updatedAt: new Date(NOW * 1000).toISOString(),
			finishedAt: null,
			source: { key: "backups/database/rst_1/rst_1.json", upload: false, filename: null },
			kept: [],
			plan: null,
			safety: null,
			rollbackPlan: null,
			cursor: null,
			interruptions: 0,
			rowCount: 0,
			error: null,
			changed: true,
			needsRecovery: false,
			recoveryOf: null,
			schema: null,
		}),
	);

	await cold.runStorageColdMaintenance(env, new Date(NOW * 1000));
	assert.equal(orphan(env, "inbound/old.eml", "sto_target"), undefined, "nothing was even marked");
	assert.ok(location(env, "inbound/old.eml"), "the location is untouched");
	assert.equal(target().has("inbound/old.eml"), true);
});

test("a migration that copies a cold-moved object back into the new hot store drops its stale location", async (t) => {
	const { env, queue } = await fixture(t);
	const actor = { id: "owner" };
	await addStore(env, "sto_target", "kite-target");
	await addStore(env, "sto_hot", "kite-target-2");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_target" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(location(env, "inbound/old.eml").store_id, "sto_target");
	assert.equal(await env.BUCKET.get("inbound/old.eml"), null, "gone from the default store");

	// Mail's active route moves to a new hot store; the migration finds the cold copy through object_locations
	// (otherwise it would read as missing from both the old and default stores) and copies it in.
	const switched = await lib.routeSwitch.switchRoute(
		env,
		actor,
		"mail",
		{ storeId: "sto_hot", migrate: true },
		APP_ORIGIN,
	);
	assert.equal(switched.ok, true, switched.ok ? undefined : switched.error);
	await drain(env, queue);
	assert.equal(
		Buffer.from(fake.buckets.get("kite-target-2").objects.get("inbound/old.eml").bytes).toString("utf8"),
		"raw old",
		"copied into the new hot store",
	);

	// The object is reachable the normal way now; the location naming the old cold target is stale and would
	// otherwise block deleting that store, and have the next cold sweep move the object again for nothing.
	assert.equal(
		location(env, "inbound/old.eml"),
		undefined,
		"dropped once the migration copies the object into the normal chain",
	);
	const routed = routerLib.createStorageRouter(env);
	assert.equal(await (await routed.get("inbound/old.eml")).text(), "raw old", "still reads fine through the chain");

	// The cold copy the migration left behind on sto_target still physically exists, though: it is tracked as
	// an orphan candidate (L1) rather than silently forgotten, which also still blocks deleting that store,
	// isolated here from the (already covered elsewhere) rule-still-targets-it block.
	assert.ok(orphan(env, "inbound/old.eml", "sto_target"), "the leftover copy is tracked for cleanup");
	env.DB.db.prepare("DELETE FROM storage_cold_rules").run();
	assert.match(await cold.coldReferenceBlocking(env, "sto_target"), /cleanup sweep/);
	assert.ok(target().has("inbound/old.eml"), "the bytes are still there, not yet deleted");

	// The candidate was marked with the real clock (migration.ts does not run on the fixture's fictional NOW),
	// so its grace period is measured against the real clock too.
	await cold.runStorageColdMaintenance(env, new Date(Date.now() + GRACE_PERIOD_DAY * DAY * 1000));
	assert.equal(target().has("inbound/old.eml"), false, "cleaned up once its grace period passed");
	assert.equal(orphan(env, "inbound/old.eml", "sto_target"), undefined);
	assert.equal(await cold.coldReferenceBlocking(env, "sto_target"), null, "sto_target is free to delete now");
	assert.equal(await (await routed.get("inbound/old.eml")).text(), "raw old", "still reads fine from the hot store");
});

test("a losing mover's copy, when two deliveries raced to different targets for the same key, is tracked and cleaned up without ever touching the winner", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_a", "kite-target");
	await addStore(env, "sto_b", "kite-target-2");
	const key = "inbound/old.eml";
	// Two deliveries of the same cold-move work (a retried queue message, a genuinely concurrent worker) each
	// copied the message to a different target and both called recordObjectLocation; the second lands here.
	await recordObjectLocation(env, { key, objectClass: "mail", storeId: "sto_a", storageClass: null, size: 10 });
	fake.buckets.get("kite-target").objects.set(key, {
		bytes: Buffer.from("the loser's copy"),
		meta: { custom: {} },
		etag: "e1",
		lastModified: new Date(),
	});
	await recordObjectLocation(env, { key, objectClass: "mail", storeId: "sto_b", storageClass: null, size: 10 });
	fake.buckets.get("kite-target-2").objects.set(key, {
		bytes: Buffer.from("the winner's copy"),
		meta: { custom: {} },
		etag: "e2",
		lastModified: new Date(),
	});

	assert.equal(location(env, key).store_id, "sto_b", "the second write is what the row names");
	assert.ok(orphan(env, key, "sto_a"), "the first target's now-untracked copy is a candidate");
	assert.equal(orphan(env, key, "sto_b"), undefined, "the winner was never touched");
	assert.match(await cold.coldReferenceBlocking(env, "sto_a"), /cleanup sweep/, "blocks deleting the loser's store");
	// sto_b is separately blocked too, for the usual reason (it holds the live location) rather than a
	// candidate of its own: the winner was never marked.
	assert.match(await cold.coldReferenceBlocking(env, "sto_b"), /sweep moved here/);

	// Well past the grace period: the loser's copy is deleted, the winner is still exactly as it was.
	await cold.runStorageColdMaintenance(env, new Date(Date.now() + GRACE_PERIOD_DAY * DAY * 1000));
	assert.equal(fake.buckets.get("kite-target").objects.has(key), false, "the loser's bytes are gone");
	assert.equal(orphan(env, key, "sto_a"), undefined);
	assert.equal(await cold.coldReferenceBlocking(env, "sto_a"), null, "sto_a is free to delete now");
	assert.equal(location(env, key).store_id, "sto_b", "the winning row is untouched throughout");
	assert.equal(
		Buffer.from(fake.buckets.get("kite-target-2").objects.get(key).bytes).toString("utf8"),
		"the winner's copy",
		"the winner's bytes are untouched throughout",
	);
});

test("recording a cold move marks the previous location as an orphan candidate in the same atomic batch, not a separate read then write", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_a", "kite-target");
	await addStore(env, "sto_b", "kite-target-2");
	const key = "inbound/race.eml";
	await recordObjectLocation(env, { key, objectClass: "mail", storeId: "sto_a", storageClass: null, size: 10 });

	const batches = [];
	const originalBatch = env.DB.batch.bind(env.DB);
	env.DB.batch = (statements) => {
		batches.push(statements.length);
		return originalBatch(statements);
	};
	try {
		await recordObjectLocation(env, { key, objectClass: "mail", storeId: "sto_b", storageClass: null, size: 10 });
	} finally {
		env.DB.batch = originalBatch;
	}

	// Both the mark of sto_a's now-superseded row and the overwrite to sto_b happened as one `DB.batch` call
	// (one SQLite transaction): there was never a window where a concurrent caller could see "nothing to mark
	// yet" (the old separate read-then-write) in between them.
	assert.deepEqual(batches, [2], "the mark and the overwrite ran together, in exactly one batch of 2 statements");
	assert.equal(location(env, key).store_id, "sto_b");
	assert.ok(orphan(env, key, "sto_a"), "the superseded row was still marked, from inside that one batch");
});

test("the orphan scan advances a stored cursor across runs instead of only ever rechecking the same oldest batch", async (t) => {
	const { env } = await fixture(t);
	// 201 unreferenced locations: one more than a single scan batch, none backed by a live message, so every
	// one of them should eventually become a candidate, just not necessarily on the very first run.
	const insert = env.DB.db.prepare(
		"INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES (?, 'mail', 'sto_x', NULL, 10, ?)",
	);
	for (let index = 0; index < 201; index++) insert.run(`inbound/key-${String(index).padStart(3, "0")}.eml`, index + 1);

	await cold.runStorageColdMaintenance(env, new Date());
	const afterFirst = env.DB.db.prepare("SELECT count(*) AS n FROM storage_cold_orphans").get().n;
	assert.equal(afterFirst, 200, "one batch's worth, oldest first");
	assert.equal(orphan(env, "inbound/key-200.eml"), undefined, "the 201st key is not reached yet");

	await cold.runStorageColdMaintenance(env, new Date());
	assert.equal(
		env.DB.db.prepare("SELECT count(*) AS n FROM storage_cold_orphans").get().n,
		201,
		"the second run resumes from the saved cursor and reaches the rest, instead of only rechecking the first 200 again",
	);
	assert.ok(orphan(env, "inbound/key-200.eml"));
});

test("saving a cold rule on a database that has 0065's storage tables but not 0097's answers migration pending, not a crash", async (t) => {
	const db = new lib.sqlite.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await lib.migrate.applyMigrations(db, beforeColdStorage);
	assert.equal(
		db.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'storage_stores'").get().n,
		1,
		"0065 is applied",
	);
	assert.equal(
		db.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'storage_cold_rules'").get().n,
		0,
		"0097 is not",
	);
	const result = await cold.updateColdRule({ DB: db }, "owner", "mail", {
		afterDays: 30,
		minBytes: 0,
		target: "r2-ia",
		enabled: true,
	});
	assert.equal(result.ok, false);
	assert.equal(result.status, 409);
	assert.equal(result.code, "MIGRATION_PENDING");
});

test("the five-minute maintenance does not crash on a database that has 0097's cold storage tables but not 0103's orphan tracking", async (t) => {
	lib.config.clearStorageConfigCache();
	lib.state.clearModuleStateCache();
	const db = new lib.sqlite.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await lib.migrate.applyMigrations(db, beforeOrphanTracking);
	assert.equal(
		db.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'object_locations'").get().n,
		1,
		"0097 is applied",
	);
	assert.equal(
		db.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'storage_cold_orphans'").get().n,
		0,
		"0103 is not",
	);
	assert.equal(
		db.db
			.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('storage_state') WHERE name = 'cold_orphan_cursor'")
			.get().n,
		0,
		"storage_state exists (0085) without 0103's extra column either",
	);
	const scratchDir = makeBundleDirectory("kite-storage-cold-before0103-");
	t.after(() => rmSync(scratchDir, { recursive: true, force: true }));
	const env = {
		DB: db,
		BUCKET: lib.files.openFileBucket(scratchDir),
		APP_ENCRYPTION_KEY: "invented-encryption-key-for-storage-tests",
		KITE_RUNTIME: "node",
		STORAGE_ALLOW_INSECURE_ENDPOINT: "1",
		STORAGE_ALLOW_PRIVATE_ENDPOINTS: "1",
		OUTBOUND_QUEUE: { send: async () => undefined },
	};
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		lib.config.clearStorageConfigCache();
	});
	// Previously this raised a raw "no such column: cold_orphan_cursor" error straight out of the five-minute
	// cron, on any install that has not yet run migration 0103; it must instead read and write that column's
	// absence the same way the rest of the codebase treats a pending migration (`missingColumnFromError`).
	await assert.doesNotReject(() => cold.runStorageColdMaintenance(env, new Date()));
});
