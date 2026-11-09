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
		coldMove: "src/lib/storage/cold-move.ts",
	},
);
const { cold, router: routerLib, stores } = lib;
const { clearStorageConfigCache } = lib.config;
const { getStorage } = lib.storageIndex;
const { recordObjectLocation } = lib.objectLocations;
const { moveColdObject } = lib.coldMove;

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

async function addBackup(
	env,
	id,
	{ size = 2048, createdAt = NOW - 60 * DAY, completedAt = createdAt, status = "completed" } = {},
) {
	// The real shape (`BACKUP_PREFIX/<id>/<filename>`, `src/lib/backups/utils.ts`): the liveness check in
	// `cold.ts`'s `stillReferenced` derives the backup id from this, so the fixture must match it exactly.
	const key = `backups/database/${id}/${id}.json`;
	env.DB.db
		.prepare(
			`INSERT INTO backups (id, status, trigger, r2_key, filename, size, created_at, completed_at) VALUES (?, ?, 'manual', ?, ?, ?, ?, ?)`,
		)
		.run(id, status, key, `${id}.json`, size, createdAt, status === "completed" ? completedAt : null);
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

test("the five-minute maintenance marks an unreferenced cold copy a candidate, and never deletes it itself", async (t) => {
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

	// This PR deletes no leftover copy at all, automatically or manually (round-9 review): the cron never
	// deletes anything, however much later it runs, and marking it again changes nothing either.
	await cold.runStorageColdMaintenance(env, new Date((NOW + GRACE_PERIOD_DAY * DAY) * 1000));
	assert.equal(target().has("inbound/old.eml"), true, "still untouched");
	assert.ok(orphan(env, "inbound/old.eml", "sto_target"));
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

test("a migration that copies a cold-moved object back into the new hot store drops its stale location, and never deletes the leftover it left behind", async (t) => {
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
	assert.match(await cold.coldReferenceBlocking(env, "sto_target"), /later release/);
	assert.ok(target().has("inbound/old.eml"), "the bytes are still there, not yet deleted");

	// This PR deletes no leftover copy at all, automatically or manually (round-9 review): the block, the
	// candidate and the bytes all remain exactly as they are no matter how much later the cron runs.
	await cold.runStorageColdMaintenance(env, new Date(Date.now() + GRACE_PERIOD_DAY * DAY * 1000));
	assert.ok(target().has("inbound/old.eml"), "still not deleted");
	assert.ok(orphan(env, "inbound/old.eml", "sto_target"));
	assert.match(await cold.coldReferenceBlocking(env, "sto_target"), /later release/, "still refused");
	assert.equal(await (await routed.get("inbound/old.eml")).text(), "raw old", "still reads fine from the hot store");
});

test("a losing mover's copy, when two deliveries raced to different targets for the same key, is tracked and never touched, same as the winner", async (t) => {
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
	assert.match(await cold.coldReferenceBlocking(env, "sto_a"), /later release/, "blocks deleting the loser's store");
	// sto_b is separately blocked too, for the usual reason (it holds the live location) rather than a
	// candidate of its own: the winner was never marked.
	assert.match(await cold.coldReferenceBlocking(env, "sto_b"), /sweep moved here/);

	// This PR deletes no leftover copy at all, automatically or manually (round-9 review): the loser's copy,
	// the winner and both blocks all remain exactly as they are no matter how much later the cron runs.
	await cold.runStorageColdMaintenance(env, new Date(Date.now() + GRACE_PERIOD_DAY * DAY * 1000));
	assert.equal(fake.buckets.get("kite-target").objects.has(key), true, "the loser's bytes are still there");
	assert.ok(orphan(env, key, "sto_a"));
	assert.match(await cold.coldReferenceBlocking(env, "sto_a"), /later release/, "still refused");
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

	// The mark of sto_a's now-superseded row, the overwrite to sto_b and the M1 clear of any stale candidate
	// already sitting on sto_b happened as one `DB.batch` call (one SQLite transaction): there was never a
	// window where a concurrent caller could see "nothing to mark yet" (the old separate read-then-write)
	// in between them.
	assert.deepEqual(batches, [3], "the mark, the overwrite and the M1 clear ran together in one batch");
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

test("B1: re-targeting a cold rule away from a store leaves no candidate behind, and the old store stays deletable through 40 days of nightly backups", async (t) => {
	const { env, queue } = await fixture(t);
	const actor = { id: "owner" };
	await addStore(env, "sto_c", "kite-target");
	await addStore(env, "sto_d", "kite-target-2");
	await addMessage(env, "m1", { createdAt: NOW - 60 * DAY });
	await addMessage(env, "m2", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_c" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(location(env, "inbound/m1.eml").store_id, "sto_c");
	assert.equal(location(env, "inbound/m2.eml").store_id, "sto_c");

	// Re-target: the sweep copies both messages to sto_d and deletes its own copies on sto_c itself.
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_d" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(location(env, "inbound/m1.eml").store_id, "sto_d");
	assert.equal(location(env, "inbound/m2.eml").store_id, "sto_d");
	assert.equal(fake.buckets.get("kite-target").objects.size, 0, "sto_c's copies were deleted by that same move");

	// No leftover candidate was ever left behind to begin with (`B1`): the mark `recordObjectLocation` made for
	// sto_c's now-superseded row was cleared the moment the mover's own delete of it succeeded.
	assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM storage_cold_orphans").get().n, 0);
	assert.equal(await cold.coldReferenceBlocking(env, "sto_c"), null, "nothing blocks deleting sto_c already");

	// 40 days of nightly backups (well past the default 14-day retention) plus daily maintenance: round-4's
	// unnarrowed retention check (`completed_at >= movedAt`, true of every one of these forever) would have
	// kept a candidate here pinned for good, had one existed. None does, and none should appear from this either.
	for (let day = 0; day < 40; day++) {
		await addBackup(env, `nightly_${day}`, { createdAt: NOW + day * DAY, completedAt: NOW + day * DAY });
		await cold.runStorageColdMaintenance(env, new Date((NOW + day * DAY) * 1000));
	}
	assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM storage_cold_orphans").get().n, 0);
	assert.equal(await cold.coldReferenceBlocking(env, "sto_c"), null);
	const result = await stores.deleteStore(env, actor, "sto_c");
	assert.equal(result.ok, true, result.ok ? undefined : result.error);
});

test("M1: recording a new location clears any stale candidate already sitting on that exact store, instead of leaving it to be judged by its old window and old grace clock", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_c", "kite-target");
	const key = "inbound/m.eml";
	// A stale leftover from 180 days ago, deferred again only 2 days ago: without M1, this row survives
	// recordObjectLocation untouched and gets judged by its OLD [movedAt, firstOrphanedAt) window and its OLD
	// orphanedAt clock once it falls out of reference again, even though the key is about to become live here.
	env.DB.db
		.prepare(
			"INSERT INTO storage_cold_orphans (id, store_id, key, object_class, moved_at, orphaned_at, first_orphaned_at) VALUES ('sco_stale', 'sto_c', ?, 'mail', ?, ?, ?)",
		)
		.run(key, NOW - 180 * DAY, NOW - 2 * DAY, NOW - 180 * DAY);

	await recordObjectLocation(env, { key, objectClass: "mail", storeId: "sto_c", storageClass: null, size: 10 });

	assert.equal(orphan(env, key, "sto_c"), undefined, "the stale row is gone: this copy is the live location now");
	assert.equal(location(env, key).store_id, "sto_c");
});

test("M1: a later reference loss on a store that cleared a stale candidate is judged by a fresh grace period and backup window, not the cleared row's old one", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_c", "kite-target");
	const key = "inbound/m.eml";
	await addMessage(env, "m", { createdAt: NOW - 200 * DAY });
	fake.buckets.get("kite-target").objects.set(key, {
		bytes: Buffer.from("raw m"),
		meta: { custom: {} },
		etag: "e1",
		lastModified: new Date(),
	});
	// recordObjectLocation (below) stamps `movedAt` with the real clock, not the fixture's fictional `NOW`
	// (the same reason the round-4 "migration that copies..." test below measures its own grace period against
	// `Date.now()`), so this whole scenario is timed against the real clock to match.
	const realNow = Math.floor(Date.now() / 1000);
	// A stale leftover from long ago, deferred again only 2 days ago.
	env.DB.db
		.prepare(
			"INSERT INTO storage_cold_orphans (id, store_id, key, object_class, moved_at, orphaned_at, first_orphaned_at) VALUES ('sco_stale', 'sto_c', ?, 'mail', ?, ?, ?)",
		)
		.run(key, realNow - 180 * DAY, realNow - 2 * DAY, realNow - 180 * DAY);

	// The key becomes current on sto_c again right now: M1 clears the stale row as part of this.
	await recordObjectLocation(env, { key, objectClass: "mail", storeId: "sto_c", storageClass: null, size: 10 });
	assert.equal(orphan(env, key, "sto_c"), undefined);
	// Backdated so the scan below (which marks a fresh candidate with today's clock as its firstOrphanedAt)
	// leaves a real gap between that and movedAt for the safety backup to land inside of; recordObjectLocation
	// itself always stamps the exact instant it runs, which would otherwise make that window a hair too narrow.
	env.DB.db.prepare("UPDATE object_locations SET moved_at = ? WHERE key = ?").run(realNow - DAY, key);

	// A safety backup completes while the message is still referenced on sto_c...
	await addBackup(env, "safety", {
		createdAt: realNow - Math.floor(DAY / 2),
		completedAt: realNow - Math.floor(DAY / 2),
	});
	// ...then the reference is lost (an older-backup restore dropping the row, the M1 shape).
	env.DB.db.prepare("DELETE FROM messages WHERE id = 'm'").run();

	await cold.runStorageColdMaintenance(env, new Date());
	assert.ok(orphan(env, key, "sto_c"), "freshly marked a candidate again, this time with today's window");

	// Without M1, the cleared row's own old deadline (orphanedAt only 2 days old when it was cleared) would
	// already have been well past its grace period by now, deleting the copy outright and ignoring the safety
	// backup above (which postdates that old window entirely). With M1 this is a brand new candidate: the grace
	// period and the backup-retention window both start fresh from today, and the safety backup still covers it.
	await cold.runStorageColdMaintenance(env, new Date(Date.now() + GRACE_PERIOD_DAY * DAY * 1000));
	assert.equal(
		fake.buckets.get("kite-target").objects.has(key),
		true,
		"kept: the fresh window still covers the safety backup",
	);
});

test("B3: recordObjectLocation's fenced write is refused once the token it was given no longer matches the row", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_a", "kite-target");
	const key = "inbound/old.eml";
	await recordObjectLocation(env, { key, objectClass: "mail", storeId: "sto_a", storageClass: null, size: 10 });
	const lease = await lib.objectLocations.claimLocationLease(env, key);
	assert.ok(lease && lease !== "none");
	// Someone else's claim is on the row now (a forced expiry and reclaim, or a genuine steal): the token this
	// caller was handed is no longer the one that matters, directly exercising the fencing check itself rather
	// than the belt-and-suspenders HEAD re-check around it.
	env.DB.db.prepare("UPDATE object_locations SET lease_token = 'someone-elses-token' WHERE key = ?").run(key);

	const recorded = await recordObjectLocation(
		env,
		{ key, objectClass: "mail", storeId: "sto_b", storageClass: null, size: 20 },
		lease,
	);
	assert.equal(recorded, false, "refused: the token this caller holds is no longer the one on the row");
	assert.equal(location(env, key).store_id, "sto_a", "the location was never actually changed");
});

test("a key with no object_locations row yet is still protected: claiming it creates the row under the claim, so a second claimant for the exact same never-before-cold key is refused", async (t) => {
	const { env } = await fixture(t);
	const key = "inbound/new.eml";
	assert.equal(location(env, key), undefined, "never cold before: no row exists yet");

	await lib.objectLocations.withLocationLease(
		env,
		key,
		{ objectClass: "mail", storeId: "sto_a", storageClass: null, size: 10 },
		async (lease) => {
			assert.ok(lease, 'claimed by creating the row, not left unprotected as round 6\'s "none" did');
			assert.equal(location(env, key).store_id, "sto_a", "the row now exists, under the claim");

			// A second claimant on the exact same never-before-cold key (a store migration can leave exactly
			// this state, round-7 review) is refused while the first still holds the row it created.
			await assert.rejects(
				() =>
					lib.objectLocations.withLocationLease(
						env,
						key,
						{ objectClass: "mail", storeId: "sto_b", storageClass: null, size: 20 },
						async () => {},
					),
				/lease/i,
			);
		},
	);

	// Free again once the first claim released it.
	await lib.objectLocations.withLocationLease(
		env,
		key,
		{ objectClass: "mail", storeId: "sto_b", storageClass: null, size: 20 },
		async (lease) => assert.ok(lease, "free again once the first claim released it"),
	);
});

test("B2: a cold move backs off instead of racing another claimant that already holds the key's lease", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_a", "kite-target");
	await addStore(env, "sto_b", "kite-target-2");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_a" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(location(env, "inbound/old.eml").store_id, "sto_a");

	// Simulate another claimant mid-decision on this exact key: it has already claimed the lease.
	const lease = await lib.objectLocations.claimLocationLease(env, "inbound/old.eml");
	assert.ok(lease && lease !== "none");

	await setColdRule(env, "mail", { afterDays: 30, target: "sto_b" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);

	assert.equal(job(env, "mail").errors, 1, "the move backed off instead of racing the held lease");
	assert.equal(fake.buckets.get("kite-target-2").objects.has("inbound/old.eml"), false, "nothing copied to sto_b");
	assert.equal(location(env, "inbound/old.eml").store_id, "sto_a", "nothing was ever recorded");
	assert.equal(fake.buckets.get("kite-target").objects.has("inbound/old.eml"), true, "the original copy is untouched");
});

/**
 * Hooks `env.DB.batch` so that the very first batch shaped like a cold move's fenced location record (the
 * only one that ever mentions `claimed_until`) runs `onHook()` to completion first, then restores the real
 * `batch` and lets that record attempt proceed: a real interleave of another claimant landing between a
 * mover's confirming HEAD and its own record, not two calls run one after the other (`B3` review).
 */
function interleaveBeforeRecord(env, onHook) {
	const originalBatch = env.DB.batch.bind(env.DB);
	let triggered = false;
	env.DB.batch = async (statements) => {
		if (!triggered && statements.some((statement) => statement.sql?.includes("claimed_until"))) {
			triggered = true;
			env.DB.batch = originalBatch;
			await onHook();
		}
		return originalBatch(statements);
	};
}

function setupB2RaceFixture(env) {
	const key = "inbound/m.eml";
	const content = "the real content of this message, to be found afterwards";
	// The message is currently cold on sto_d...
	fake.buckets.get("kite-target-2").objects.set(key, {
		bytes: Buffer.from(content),
		meta: { custom: {} },
		etag: "ed",
		lastModified: new Date(),
	});
	env.DB.db
		.prepare(
			"INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES (?, 'mail', 'sto_d', NULL, ?, ?)",
		)
		.run(key, Buffer.byteLength(content), NOW - 90 * DAY);
	// ...while sto_c still holds an unrelated, stale leftover copy from before, tracked as a past-grace candidate.
	fake.buckets.get("kite-target").objects.set(key, {
		bytes: Buffer.from("x"),
		meta: { custom: {} },
		etag: "ec",
		lastModified: new Date(),
	});
	env.DB.db
		.prepare(
			"INSERT INTO storage_cold_orphans (id, store_id, key, object_class, moved_at, orphaned_at, first_orphaned_at) VALUES ('sco_m', 'sto_c', ?, 'mail', ?, ?, ?)",
		)
		.run(key, NOW - 120 * DAY, NOW - GRACE_PERIOD_DAY * DAY, NOW - GRACE_PERIOD_DAY * DAY);
	return { key, content };
}

test("B2: a move back onto a store that already holds an unrelated, inert orphan candidate for the same key still leaves a readable copy", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_c", "kite-target");
	await addStore(env, "sto_d", "kite-target-2");
	const { key, content } = setupB2RaceFixture(env);
	await addMessage(env, "m", { body: content, createdAt: NOW - 90 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_c" });

	// The five-minute maintenance genuinely runs in the middle of the move, after its confirming HEAD and
	// before its own record, not merely before or after it: it only ever marks (nothing in this PR deletes a
	// candidate, round-9 review), so it cannot disturb the move, and the stale candidate on sto_c stays inert.
	interleaveBeforeRecord(env, () => cold.runStorageColdMaintenance(env, new Date(NOW * 1000)));
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "mail").errors, 0, job(env, "mail").last_error);

	const routed = routerLib.createStorageRouter(env);
	assert.equal(await (await routed.get(key)).text(), content, "the message still reads, with the right bytes");
	assert.equal(location(env, key).store_id, "sto_c");
	assert.equal(fake.buckets.get("kite-target-2").objects.has(key), false, "sto_d's copy was cleaned up by the move");
});

test("B2: a move whose lease has already lapsed mid-move aborts instead of letting both copies be deleted", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_c", "kite-target");
	await addStore(env, "sto_d", "kite-target-2");
	const { key, content } = setupB2RaceFixture(env);
	await addMessage(env, "m", { body: content, createdAt: NOW - 90 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_c" });

	// Stands in for a move that ran past its lease window (a large Drive file, say): right between the
	// confirming HEAD and the record, the lease is force-expired, exactly the round-6 B3 scenario; the
	// five-minute maintenance running alongside it only ever marks, never claims or deletes.
	interleaveBeforeRecord(env, async () => {
		env.DB.db.prepare("UPDATE object_locations SET claimed_until = 0 WHERE key = ?").run(key);
		await cold.runStorageColdMaintenance(env, new Date(NOW * 1000));
	});
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "mail").errors, 1, "the move's own record lost the fence and aborted");

	// The move never deleted sto_d's copy, because its own fenced record never landed: at least one copy is
	// always left, and it is always the one readable through the router.
	const routed = routerLib.createStorageRouter(env);
	assert.equal(await (await routed.get(key)).text(), content, "a readable copy always survives");
	assert.equal(location(env, key).store_id, "sto_d", "the move's record never landed; the old location stands");
	assert.equal(fake.buckets.get("kite-target-2").objects.has(key), true, "the source the move never got to delete");
});

/**
 * Reproduces B4: the lease lapses between a move's confirming HEAD and its own record, a second mover of the
 * exact same key (a resent batch, a redelivered queue message — the normal recovery machinery a lapsed lease
 * hands the key to) claims the freed lease and completes the whole move itself, and only then does the first
 * mover's stale record attempt resume. The first mover's refusal must never delete the second mover's own,
 * already-recorded copy: whichever direction, and whichever mover's own copy step actually ran, there must
 * always be exactly the one copy the current location names, never zero.
 */
async function runSecondMoverTakeover(t, { sourceStoreId, sourceBucket, targetStoreId, targetBucket, skipCopy }) {
	const { env } = await fixture(t);
	await addStore(env, "sto_c", "kite-target");
	await addStore(env, "sto_d", "kite-target-2");
	const key = "inbound/m.eml";
	const content = "the real content of this message, to be found afterwards";
	await addMessage(env, "m", { body: content, createdAt: NOW - 90 * DAY });
	// The message is currently cold on the source store...
	fake.buckets.get(sourceBucket).objects.set(key, {
		bytes: Buffer.from(content),
		meta: { custom: {} },
		etag: "es",
		lastModified: new Date(),
	});
	env.DB.db
		.prepare(
			"INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES (?, 'mail', ?, NULL, ?, ?)",
		)
		.run(key, sourceStoreId, Buffer.byteLength(content), NOW - 90 * DAY);
	if (skipCopy) {
		// The target already has byte-identical content, so the first mover's own copy step is skipped
		// (`matchesExisting`); without this, it performs a real copy before the hook ever fires.
		fake.buckets.get(targetBucket).objects.set(key, {
			bytes: Buffer.from(content),
			meta: { custom: {} },
			etag: "et",
			lastModified: new Date(),
		});
	}

	const rule = { objectClass: "mail", afterDays: 30, minBytes: 0, target: targetStoreId };
	const item = { id: "m", key, size: null, createdAt: new Date((NOW - 90 * DAY) * 1000) };
	const storage = await getStorage(env);

	interleaveBeforeRecord(env, async () => {
		// Stands in for a move that ran past its lease window (a large Drive file, say).
		env.DB.db.prepare("UPDATE object_locations SET claimed_until = 0 WHERE key = ?").run(key);
		await moveColdObject(env, storage, "mail", rule, item);
	});
	await assert.rejects(() => moveColdObject(env, storage, "mail", rule, item), /lease/i);

	const routed = routerLib.createStorageRouter(env);
	assert.equal(await (await routed.get(key)).text(), content, "a readable copy always survives (B4)");
	assert.equal(location(env, key).store_id, targetStoreId, "the second mover's own completed record stands");
	assert.equal(fake.buckets.get(targetBucket).objects.has(key), true, "the live target copy was never deleted");
}

test("B4: a second mover D→C that takes over a lapsed lease and completes the move is never undone by the first mover's refused record (copy made)", async (t) => {
	await runSecondMoverTakeover(t, {
		sourceStoreId: "sto_d",
		sourceBucket: "kite-target-2",
		targetStoreId: "sto_c",
		targetBucket: "kite-target",
		skipCopy: false,
	});
});

test("B4: a second mover D→C that takes over a lapsed lease and completes the move is never undone by the first mover's refused record (copy skipped)", async (t) => {
	await runSecondMoverTakeover(t, {
		sourceStoreId: "sto_d",
		sourceBucket: "kite-target-2",
		targetStoreId: "sto_c",
		targetBucket: "kite-target",
		skipCopy: true,
	});
});

test("B4: a second mover C→D that takes over a lapsed lease and completes the move is never undone by the first mover's refused record (copy made)", async (t) => {
	await runSecondMoverTakeover(t, {
		sourceStoreId: "sto_c",
		sourceBucket: "kite-target",
		targetStoreId: "sto_d",
		targetBucket: "kite-target-2",
		skipCopy: false,
	});
});

test("B4: a second mover C→D that takes over a lapsed lease and completes the move is never undone by the first mover's refused record (copy skipped)", async (t) => {
	await runSecondMoverTakeover(t, {
		sourceStoreId: "sto_c",
		sourceBucket: "kite-target",
		targetStoreId: "sto_d",
		targetBucket: "kite-target-2",
		skipCopy: true,
	});
});

test("B4: the first mover's refused record only marks the target a candidate when the live location does not already name it", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_c", "kite-target");
	await addStore(env, "sto_d", "kite-target-2");
	const { key, content } = setupB2RaceFixture(env);
	await addMessage(env, "m", { body: content, createdAt: NOW - 90 * DAY });
	const rule = { objectClass: "mail", afterDays: 30, minBytes: 0, target: "sto_c" };
	const item = { id: "m", key, size: null, createdAt: new Date((NOW - 90 * DAY) * 1000) };
	const storage = await getStorage(env);

	interleaveBeforeRecord(env, async () => {
		env.DB.db.prepare("UPDATE object_locations SET claimed_until = 0 WHERE key = ?").run(key);
		await moveColdObject(env, storage, "mail", rule, item);
	});
	await assert.rejects(() => moveColdObject(env, storage, "mail", rule, item), /lease/i);

	// The second mover's own record landed on sto_c, so the first mover's refusal must not mark that same
	// copy a candidate (it is the live location, not a leftover): only the reverse case (B2/B3's tests above)
	// exercises marking one, which this would otherwise immediately make eligible for deletion once a grace
	// period passed, destroying the only copy all over again.
	assert.equal(orphan(env, key, "sto_c"), undefined, "the live copy was never marked a candidate");
});

test("B4 (Drive): a second mover that takes over a lapsed lease and completes the move is never undone by the first mover's refused record", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_c", "kite-target");
	await addStore(env, "sto_d", "kite-target-2");
	const content = Buffer.from("the real content of this drive file, to be found afterwards");
	await addDriveFile(env, "drv_1", content, { storeId: "sto_d", createdAt: NOW - 90 * DAY });
	env.DB.db
		.prepare(
			"INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES ('drive/drv_1', 'drive', 'sto_d', NULL, ?, ?)",
		)
		.run(content.length, NOW - 90 * DAY);

	const rule = { objectClass: "drive", afterDays: 30, minBytes: 0, target: "sto_c" };
	const item = {
		id: "drv_1",
		key: "drive/drv_1",
		size: content.length,
		createdAt: new Date((NOW - 90 * DAY) * 1000),
		storeId: "sto_d",
	};
	const storage = await getStorage(env);

	interleaveBeforeRecord(env, async () => {
		env.DB.db.prepare("UPDATE object_locations SET claimed_until = 0 WHERE key = ?").run(item.key);
		await lib.coldMove.moveColdDriveObject(env, storage, rule, item);
	});
	await assert.rejects(() => lib.coldMove.moveColdDriveObject(env, storage, rule, item), /lease/i);

	assert.equal(fake.buckets.get("kite-target").objects.has(item.key), true, "the live target copy was never deleted");
	assert.equal(location(env, item.key).store_id, "sto_c", "the second mover's own completed record stands");
	assert.equal(
		env.DB.db.prepare("SELECT store_id FROM drive_items WHERE id = 'drv_1'").get().store_id,
		"sto_c",
		"the row was repointed by whichever mover actually finished",
	);
});

test("B5: a failed first move of a key with no location row names where the bytes truly are, not the empty target, so the next sweep still finds and moves it", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_c", "kite-target");
	await addMessage(env, "old", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_c" });

	// The very first move of this key (no object_locations row exists yet) fails after the claim creates one:
	// the write to the target is denied.
	fake.state.denied.add("PutObject");
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	fake.state.denied.delete("PutObject");
	assert.equal(job(env, "mail").errors, 1);
	// The claim-created row must name where the bytes truly are (the default store), not the target nothing
	// was ever actually copied to (`B5`): otherwise the key is silently excluded from every later sweep
	// (`coldPage`'s own `NOT EXISTS … store_id = target` check) and the store can never be deleted either.
	assert.equal(location(env, "inbound/old.eml")?.store_id, "default", "names the source, not the empty target");
	assert.equal(fake.buckets.get("kite-target").objects.has("inbound/old.eml"), false, "nothing was ever copied");

	env.DB.db.prepare("DELETE FROM storage_cold_jobs WHERE object_class = 'mail'").run();
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	assert.equal(job(env, "mail").errors, 0, "the retry actually finds and moves it this time");
	assert.equal(location(env, "inbound/old.eml").store_id, "sto_c");
	assert.equal(fake.buckets.get("kite-target").objects.has("inbound/old.eml"), true);
});

test("m1: the 'already at target' shortcut takes the same lease too, so a concurrent mover cannot race its record", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_c", "kite-target");
	const key = "inbound/m.eml";
	const content = "the real content of this message, already sitting on the target directly";
	await addMessage(env, "m", { body: content, createdAt: NOW - 90 * DAY });
	fake.buckets.get("kite-target").objects.set(key, {
		bytes: Buffer.from(content),
		meta: { custom: {} },
		etag: "ec",
		lastModified: new Date(),
	});
	env.DB.db
		.prepare(
			"INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES (?, 'mail', 'sto_c', NULL, ?, ?)",
		)
		.run(key, Buffer.byteLength(content), NOW - 90 * DAY);

	// Someone else (another mover) already holds this key's lease.
	const lease = await lib.objectLocations.claimLocationLease(env, key);
	assert.ok(lease && lease !== "none");

	const rule = { objectClass: "mail", afterDays: 30, minBytes: 0, target: "sto_c" };
	const item = { id: "m", key, size: null, createdAt: new Date((NOW - 90 * DAY) * 1000) };
	const storage = await getStorage(env);
	// Before this fix, the shortcut recorded with no claim at all and would have gone through regardless.
	await assert.rejects(() => moveColdObject(env, storage, "mail", rule, item), /lease/i);
	assert.equal(location(env, key).store_id, "sto_c", "untouched while the lease is held elsewhere");

	await lib.objectLocations.releaseLocationLease(env, key, lease.token);
	await moveColdObject(env, storage, "mail", rule, item);
	assert.equal(location(env, key).store_id, "sto_c", "succeeds normally once the lease is free");
});

test("m5: the r2-ia same-store rewrite takes a lease too, so a concurrent mover cannot race its record", async (t) => {
	const { env } = await fixture(t);
	const key = "inbound/ia.eml";
	await addMessage(env, "ia", { createdAt: NOW - 60 * DAY });
	env.KITE_RUNTIME = "workers";
	clearStorageConfigCache();
	env.DB.db
		.prepare(
			"INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES (?, 'mail', 'default', NULL, ?, ?)",
		)
		.run(key, 10, NOW - 60 * DAY);

	// Someone else (another mover) already holds this key's lease.
	const lease = await lib.objectLocations.claimLocationLease(env, key);
	assert.ok(lease && lease !== "none");

	const rule = { objectClass: "mail", afterDays: 30, minBytes: 0, target: "r2-ia" };
	const item = { id: "ia", key, size: null, createdAt: new Date((NOW - 60 * DAY) * 1000) };
	const storage = await getStorage(env);
	// Before this fix, the rewrite recorded with no claim at all and would have gone through regardless.
	await assert.rejects(() => moveColdObject(env, storage, "mail", rule, item), /lease/i);
	assert.equal(location(env, key).storage_class, null, "untouched while the lease is held elsewhere");

	await lib.objectLocations.releaseLocationLease(env, key, lease.token);
	await moveColdObject(env, storage, "mail", rule, item);
	assert.equal(location(env, key).storage_class, "InfrequentAccess", "succeeds normally once the lease is free");
});

test("m3: the shortcut marks a copy still on the normal chain a candidate, instead of leaving it untracked forever", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_c", "kite-target");
	const key = "inbound/m.eml";
	const content = "the real content of this message";
	// The object is found directly on the target (the rule's own probe, before the normal chain is ever
	// consulted), while the normal chain's own store (here, the default one `addMessage` writes to) still
	// separately holds its own copy too.
	await addMessage(env, "m", { body: content, createdAt: NOW - 60 * DAY });
	fake.buckets.get("kite-target").objects.set(key, {
		bytes: Buffer.from(content),
		meta: { custom: {} },
		etag: "ec",
		lastModified: new Date(),
	});

	await setColdRule(env, "mail", { afterDays: 30, target: "sto_c" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);

	assert.equal(job(env, "mail").errors, 0, job(env, "mail").last_error);
	assert.equal(location(env, key).store_id, "sto_c");
	// The default store's own copy is now redundant and was never deleted or recorded by the shortcut: left
	// untracked, it would stay hot forever, defeating cold storage for this object with nobody the wiser.
	assert.ok(orphan(env, key, "default"), "the normal chain's own copy is marked a candidate instead");
});

test("B6: no code path in this PR ever deletes an orphan candidate's copy, however long it has been marked", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_a", "kite-target");
	await addStore(env, "sto_b", "kite-target-2");

	// A plain unreferenced leftover, the ordinary case the five-minute maintenance marks on its own.
	await addMessage(env, "plain", { createdAt: NOW - 60 * DAY });
	await setColdRule(env, "mail", { afterDays: 30, target: "sto_a" });
	await cold.runColdStorageSweep(env, new Date(NOW * 1000));
	await drain(env, queue);
	env.DB.db.prepare("DELETE FROM messages WHERE id = 'plain'").run();
	await cold.runStorageColdMaintenance(env, new Date(NOW * 1000));
	assert.ok(orphan(env, "inbound/plain.eml", "sto_a"), "marked as a candidate");

	// A losing mover's copy from a two-target race (no message row ever points at this key directly; it is
	// tracked purely through recordObjectLocation's own markPrevious).
	const raceKey = "inbound/race.eml";
	await recordObjectLocation(env, {
		key: raceKey,
		objectClass: "mail",
		storeId: "sto_a",
		storageClass: null,
		size: 10,
	});
	fake.buckets.get("kite-target").objects.set(raceKey, {
		bytes: Buffer.from("loser"),
		meta: { custom: {} },
		etag: "e1",
		lastModified: new Date(),
	});
	await recordObjectLocation(env, {
		key: raceKey,
		objectClass: "mail",
		storeId: "sto_b",
		storageClass: null,
		size: 10,
	});
	fake.buckets.get("kite-target-2").objects.set(raceKey, {
		bytes: Buffer.from("winner"),
		meta: { custom: {} },
		etag: "e2",
		lastModified: new Date(),
	});
	assert.ok(orphan(env, raceKey, "sto_a"), "the loser is tracked too");

	// Every maintenance entry point, run repeatedly, well past any notion of a grace period: B6 (round-9
	// review) found the one path that used to delete a candidate like these unfenced for a key with no
	// object_locations row; the fix was to remove that whole path rather than fence it further.
	for (let day = 1; day <= 90; day += 7) {
		await cold.runStorageColdMaintenance(env, new Date((NOW + day * DAY) * 1000));
	}

	assert.equal(target().has("inbound/plain.eml"), true, "the plain leftover's copy is exactly as it was");
	assert.ok(orphan(env, "inbound/plain.eml", "sto_a"), "still tracked, never removed");
	assert.ok(location(env, "inbound/plain.eml"), "the stale location row is untouched too");
	assert.equal(fake.buckets.get("kite-target").objects.has(raceKey), true, "the losing mover's copy survives too");
	assert.ok(orphan(env, raceKey, "sto_a"));
	assert.equal(
		Buffer.from(fake.buckets.get("kite-target-2").objects.get(raceKey).bytes).toString("utf8"),
		"winner",
		"the winner is never touched either",
	);

	// The deletion machinery itself was removed, not just left unreached: nothing exported from either module
	// offers a way to delete a tracked candidate's copy.
	for (const name of [
		"purgeColdOrphans",
		"purgeOrphanCandidates",
		"deleteGracePeriodOrphans",
		"finalizeOrphanCandidate",
	]) {
		assert.equal(name in cold, false, `cold.${name} must not exist`);
	}
});
