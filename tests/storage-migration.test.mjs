import assert from "node:assert/strict";
import test from "node:test";
import { APP_ORIGIN as ORIGIN, loadStorageServices } from "./support/storage-services.mjs";

const { lib, fake, fixture, addStore } = await loadStorageServices("kite-storage-migration-", [
	"kite-target",
	"kite-other",
]);
const { migration, stores, routeSwitch } = lib;
const { clearStorageConfigCache } = lib.config;

function setRoute(env, objectClass, storeId, previousStoreId) {
	env.DB.db
		.prepare(
			`INSERT INTO storage_routes (object_class, store_id, previous_store_id, updated_at) VALUES (?, ?, ?, 1)
			 ON CONFLICT (object_class) DO UPDATE SET store_id = excluded.store_id, previous_store_id = excluded.previous_store_id`,
		)
		.run(objectClass, storeId, previousStoreId);
	clearStorageConfigCache();
}

async function addMessage(env, id, { body = `raw ${id}`, attachments = [] } = {}) {
	const rawKey = `inbound/${id}.eml`;
	env.DB.db
		.prepare(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at)
			 VALUES (?, 'owner', 'mailbox-a', 'inbound', 'sender@example.net', 'a@example.com', 'Hello', 'received', ?, 1)`,
		)
		.run(id, rawKey);
	await env.BUCKET.put(rawKey, body, { httpMetadata: { contentType: "message/rfc822" } });
	for (const [index, content] of attachments.entries()) {
		const key = `attachments/${id}/${index}`;
		env.DB.db
			.prepare(
				`INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at)
				 VALUES (?, ?, ?, 'text/plain', ?, ?, 1)`,
			)
			.run(`${id}-att-${index}`, id, `file-${index}.txt`, content.length, key);
		await env.BUCKET.put(key, content);
	}
	return rawKey;
}

async function addDriveFile(env, id, content, storeId = "default") {
	env.DB.db
		.prepare(
			`INSERT INTO drive_items (id, owner_id, kind, name, size, store_id, object_key, status, created_at, updated_at)
			 VALUES (?, 'owner', 'file', ?, ?, ?, ?, 'ready', 1, 1)`,
		)
		.run(id, `${id}.txt`, content.length, storeId, `drive/${id}`);
	await env.BUCKET.put(`drive/${id}`, content);
}

/** Delivers queued messages until the job stops re-enqueueing itself, or `limit` batches ran. */
async function drain(env, queue, limit = 100) {
	let batches = 0;
	while (queue.length && batches < limit) {
		const { message } = queue.shift();
		await migration.processStorageMigration(env, message);
		batches += 1;
	}
	return batches;
}

const job = (env, id) => env.DB.db.prepare("SELECT * FROM storage_migrations WHERE id = ?").get(id);
const target = () => fake.buckets.get("kite-target").objects;
const asText = (entry) => (entry ? Buffer.from(entry.bytes).toString("utf8") : undefined);
const targetText = (key) => asText(target().get(key));

test("a mail migration copies raw messages and attachments, verifies them and leaves the source alone", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1", { attachments: ["first attachment", "second"] });
	await addMessage(env, "m2");
	// A forward on m2 shares m1's first attachment: one object, walked and counted once.
	env.DB.db
		.prepare(
			`INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at)
			 VALUES ('m2-forward', 'm2', 'file-0.txt', 'text/plain', 16, 'attachments/m1/0', 1)`,
		)
		.run();
	await env.BUCKET.put("avatars/owner", "avatar bytes");
	setRoute(env, "mail", "sto_target", "default");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: "owner",
	});
	assert.equal(job(env, id).objects_total, 4);
	await drain(env, queue);
	const done = job(env, id);
	assert.equal(done.status, "completed");
	assert.equal(done.objects_done, 4);
	assert.equal(done.errors, 0);
	assert.ok(done.finished_at);
	assert.equal(targetText("inbound/m1.eml"), "raw m1");
	assert.equal(targetText("attachments/m1/0"), "first attachment");
	assert.equal(target().get("inbound/m1.eml").meta.contentType, "message/rfc822", "metadata travels with the copy");
	assert.equal(target().has("avatars/owner"), false, "system objects never move");
	assert.equal(await (await env.BUCKET.get("inbound/m1.eml")).text(), "raw m1", "the source keeps its copy");
	assert.equal(queue.length, 0);
});

test("a migration resumes from its cursor across batches and a re-run copies nothing again", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	for (let index = 0; index < 55; index += 1) await addMessage(env, `m${String(index).padStart(3, "0")}`);
	setRoute(env, "mail", "sto_target", "default");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	await drain(env, queue, 1);
	const first = job(env, id);
	const cursor = JSON.parse(first.cursor);
	assert.equal(cursor.phase, "copy");
	assert.equal(cursor.sources.messages, "m049");
	assert.equal(first.objects_done, 50);
	assert.equal(cursor.leaseUntil, undefined, "the lease is released after the batch");
	assert.equal(queue.length, 1, "the next batch is queued");
	await drain(env, queue);
	assert.equal(job(env, id).status, "completed");
	assert.equal(target().size, 55);
	const bytes = job(env, id).bytes_done;

	const again = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	await drain(env, queue);
	assert.equal(job(env, again).status, "completed");
	assert.equal(job(env, again).bytes_done, 0, "objects already on the target are not copied again");
	assert.ok(bytes > 0);
});

test("a duplicate delivery of a leased job does nothing", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	const leased = { phase: "copy", sources: { messages: null, attachments: null }, leaseUntil: Date.now() + 60_000 };
	env.DB.db.prepare("UPDATE storage_migrations SET cursor = ? WHERE id = ?").run(JSON.stringify(leased), id);
	await drain(env, queue);
	assert.equal(job(env, id).objects_done, 0);
	assert.equal(target().size, 0);
});

test("the verify pass copies objects that reached the old store after the copy passed them", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1");
	setRoute(env, "mail", "sto_target", "default");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	while (queue.length && JSON.parse(job(env, id).cursor).phase === "copy") await drain(env, queue, 1);
	assert.equal(job(env, id).status, "verifying");
	// A stale isolate wrote this message to the old store, and the target lost another copy.
	await addMessage(env, "m0", { body: "late arrival" });
	target().delete("inbound/m1.eml");
	await drain(env, queue);
	assert.equal(job(env, id).status, "completed");
	assert.equal(targetText("inbound/m0.eml"), "late arrival");
	assert.equal(targetText("inbound/m1.eml"), "raw m1");
});

test("an object missing from both stores is counted as an error and the job still completes", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1");
	await env.BUCKET.delete("inbound/m1.eml");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	await drain(env, queue);
	const done = job(env, id);
	assert.equal(done.status, "completed");
	assert.equal(done.errors, 2, "once in the copy pass and once in verify");
	assert.match(done.last_error, /missing from both stores/);
});

test("a cancelled migration stops after the current batch", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	for (let index = 0; index < 60; index += 1) await addMessage(env, `m${String(index).padStart(3, "0")}`);
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	await drain(env, queue, 1);
	const running = await migration.getStorageMigration(env, id);
	const cancelled = await migration.actOnStorageMigration(env, running, "cancel");
	assert.equal(cancelled.ok, true);
	assert.equal(cancelled.job.status, "cancelled");
	await drain(env, queue);
	assert.equal(job(env, id).status, "cancelled");
	assert.equal(target().size, 50);
	const again = await migration.actOnStorageMigration(env, cancelled.job, "cancel");
	assert.equal(again.ok, false);
	assert.equal(again.status, 409);
});

test("a Drive migration copies files through the Drive hooks and moves each row's store_id", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addDriveFile(env, "drv_a", "alpha");
	await addDriveFile(env, "drv_b", "bravo");
	env.DB.db
		.prepare(
			`INSERT INTO drive_items (id, owner_id, kind, name, size, store_id, object_key, status, created_at, updated_at)
			 VALUES ('drv_up', 'owner', 'file', 'partial.bin', 10, 'default', 'drive/drv_up', 'uploading', 1, 1)`,
		)
		.run();
	setRoute(env, "drive", "sto_target", "default");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "drive",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: "owner",
	});
	assert.equal(job(env, id).objects_total, 3, "the count includes uploads in progress");
	await drain(env, queue);
	assert.equal(job(env, id).status, "completed");
	const rows = env.DB.db.prepare("SELECT id, store_id FROM drive_items ORDER BY id").all();
	assert.deepEqual(
		rows.map((row) => [row.id, row.store_id]),
		[
			["drv_a", "sto_target"],
			["drv_b", "sto_target"],
			["drv_up", "default"],
		],
	);
	assert.equal(targetText("drive/drv_a"), "alpha");
	assert.equal(target().has("drive/drv_up"), false, "uploads in progress stay where their parts are");
});

test("purge deletes only the migrated keys from the old store and drops it from the read chain", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1", { attachments: ["a"] });
	await env.BUCKET.put("inbound/orphan.eml", "no row names this");
	setRoute(env, "mail", "sto_target", "default");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	await drain(env, queue);
	const refused = await stores.storageOverview(env);
	assert.equal(refused.routes.find((route) => route.objectClass === "mail").previousStoreId, "default");
	const wrong = await routeSwitch.runMigrationAction(env, { id: "owner" }, id, {
		action: "purge-source",
		confirm: "nope",
	});
	assert.equal(wrong.ok, false);
	assert.equal(wrong.status, 400);
	const purge = await routeSwitch.runMigrationAction(env, { id: "owner" }, id, {
		action: "purge-source",
		confirm: "local files",
	});
	assert.equal(purge.ok, true);
	await drain(env, queue);
	assert.equal(await env.BUCKET.get("inbound/m1.eml"), null);
	assert.equal(await env.BUCKET.get("attachments/m1/0"), null);
	assert.equal(await (await env.BUCKET.get("inbound/orphan.eml")).text(), "no row names this");
	assert.equal(targetText("inbound/m1.eml"), "raw m1");
	assert.equal(JSON.parse(job(env, id).cursor).phase, "purged");
	const route = env.DB.db.prepare("SELECT * FROM storage_routes WHERE object_class = 'mail'").get();
	assert.equal(route.previous_store_id, null);
	const audit = env.DB.db.prepare("SELECT action FROM audit_logs").all();
	assert.ok(audit.some((row) => row.action === "storage.migration_purged"));
});

test("a mail migration moves offloaded HTML bodies, and the purge removes the old copies", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1");
	await addMessage(env, "m2");
	env.DB.db.exec("UPDATE messages SET html_body_key = 'bodies/m1.html' WHERE id = 'm1'");
	await env.BUCKET.put("bodies/m1.html", "<p>Offloaded body</p>", { httpMetadata: { contentType: "text/html" } });
	// A body object no row names stays where it is, like any other orphan.
	await env.BUCKET.put("bodies/m2.html", "<p>Not offloaded</p>");
	setRoute(env, "mail", "sto_target", "default");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	assert.equal(job(env, id).objects_total, 3, "two raw messages and one body");
	await drain(env, queue);
	assert.equal(job(env, id).status, "completed");
	assert.equal(job(env, id).objects_done, 3);
	assert.equal(targetText("bodies/m1.html"), "<p>Offloaded body</p>");
	assert.equal(target().get("bodies/m1.html").meta.contentType, "text/html");
	assert.equal(target().has("bodies/m2.html"), false);
	const purge = await routeSwitch.runMigrationAction(env, { id: "owner" }, id, {
		action: "purge-source",
		confirm: "local files",
	});
	assert.equal(purge.ok, true);
	await drain(env, queue);
	assert.equal(JSON.parse(job(env, id).cursor).phase, "purged");
	assert.equal(await env.BUCKET.get("bodies/m1.html"), null);
	assert.equal(targetText("bodies/m1.html"), "<p>Offloaded body</p>");
	assert.equal(await (await env.BUCKET.get("bodies/m2.html")).text(), "<p>Not offloaded</p>");
});

test("before migration 0074 a mail migration moves raw mail and attachments without the bodies source", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1", { attachments: ["a"] });
	env.DB.db.exec("ALTER TABLE messages DROP COLUMN html_body_key");
	setRoute(env, "mail", "sto_target", "default");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	assert.equal(job(env, id).objects_total, 2);
	await drain(env, queue);
	assert.equal(job(env, id).status, "completed");
	assert.equal(job(env, id).errors, 0);
	assert.equal(targetText("inbound/m1.eml"), "raw m1");
});

test("the cron restarts stalled jobs and finishes migrations completed a week ago", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1");
	setRoute(env, "mail", "sto_target", "default");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	queue.length = 0;
	await migration.runStorageMigrationMaintenance(env, new Date());
	assert.equal(queue.length, 0, "a job created just now is not stalled");
	await migration.runStorageMigrationMaintenance(env, new Date(Date.now() + 6 * 60 * 1000));
	assert.equal(queue.length, 1);
	await drain(env, queue);
	assert.equal(job(env, id).status, "completed");
	await migration.runStorageMigrationMaintenance(env, new Date(Date.now() + 6 * 24 * 60 * 60 * 1000));
	assert.equal(env.DB.db.prepare("SELECT previous_store_id FROM storage_routes").get().previous_store_id, "default");
	await migration.runStorageMigrationMaintenance(env, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
	assert.equal(env.DB.db.prepare("SELECT previous_store_id FROM storage_routes").get().previous_store_id, null);
	assert.equal(queue.length, 0);
});

test("retrying a failed purge stays completed and preserves its terminal phase and finish time", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1");
	setRoute(env, "mail", "sto_target", "default");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	await drain(env, queue);
	const finishedAt = job(env, id).finished_at;
	assert.equal(
		(await migration.startStorageMigrationPurge(env, await migration.getStorageMigration(env, id))).ok,
		true,
	);
	env.DB.db.prepare("UPDATE storage_migrations SET from_store_id = 'sto_missing' WHERE id = ?").run(id);
	await drain(env, queue);
	assert.equal(job(env, id).status, "failed");
	assert.equal(JSON.parse(job(env, id).cursor).phase, "purge");
	env.DB.db.prepare("UPDATE storage_migrations SET from_store_id = 'default' WHERE id = ?").run(id);
	const retried = await migration.actOnStorageMigration(env, await migration.getStorageMigration(env, id), "retry");
	assert.equal(retried.ok, true);
	assert.equal(retried.job.status, "completed");
	assert.equal(JSON.parse(retried.job.cursor).failures, 0);
	assert.equal(await migration.activeMigrationFor(env, "mail"), null);
	await drain(env, queue);
	assert.equal(await env.BUCKET.head("inbound/m1.eml"), null);
	assert.equal(job(env, id).status, "completed");
	assert.equal(JSON.parse(job(env, id).cursor).phase, "purged");
	assert.equal(job(env, id).finished_at, finishedAt);
	await migration.processStorageMigration(env, { kind: "storage.migrate", jobId: id });
	await migration.runStorageMigrationMaintenance(env, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
	assert.equal(queue.length, 0);
	assert.equal(JSON.parse(job(env, id).cursor).phase, "purged");
	assert.equal(job(env, id).finished_at, finishedAt);
});

test("retrying a failed verification resumes with verifying status", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_target",
		createdByUserId: null,
	});
	queue.length = 0;
	env.DB.db
		.prepare("UPDATE storage_migrations SET status = 'failed', cursor = ? WHERE id = ?")
		.run(JSON.stringify({ phase: "verify", sources: { messages: null, attachments: null }, failures: 5 }), id);
	const retried = await migration.actOnStorageMigration(env, await migration.getStorageMigration(env, id), "retry");
	assert.equal(retried.ok, true);
	assert.equal(retried.job.status, "verifying");
	await drain(env, queue);
	assert.equal(job(env, id).status, "completed");
	assert.equal(targetText("inbound/m1.eml"), "raw m1");
});

test("a failing batch is retried later and the job fails after repeated failures", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	await addMessage(env, "m1");
	const id = await migration.queueStorageMigration(env, {
		objectClass: "mail",
		fromStoreId: "default",
		toStoreId: "sto_missing",
		createdByUserId: null,
	});
	for (let attempt = 0; attempt < 5; attempt += 1) {
		assert.equal(queue.length, 1);
		await drain(env, queue, 1);
	}
	const failed = job(env, id);
	assert.equal(failed.status, "failed");
	assert.match(failed.last_error, /missing or blocked/);
	assert.equal(queue.length, 0);
	env.DB.db.prepare("UPDATE storage_migrations SET to_store_id = 'sto_target' WHERE id = ?").run(id);
	const retried = await migration.actOnStorageMigration(env, await migration.getStorageMigration(env, id), "retry");
	assert.equal(retried.ok, true);
	await drain(env, queue);
	assert.equal(job(env, id).status, "completed");
});

test("switching a route validates the target, queues the copy and refuses a second switch", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_target", "kite-target", "Target");
	await addStore(env, "sto_other", "kite-other", "Other");
	await addMessage(env, "m1");
	const actor = { id: "owner" };
	const switched = await routeSwitch.switchRoute(env, actor, "mail", { storeId: "sto_target", migrate: true }, ORIGIN);
	assert.equal(switched.ok, true);
	assert.ok(switched.migrationId);
	const busy = await routeSwitch.switchRoute(env, actor, "mail", { storeId: "sto_other", migrate: true }, ORIGIN);
	assert.equal(busy.status, 409, "one migration per class at a time");
	await drain(env, queue);
	assert.equal(targetText("inbound/m1.eml"), "raw m1");
	const route = env.DB.db.prepare("SELECT * FROM storage_routes WHERE object_class = 'mail'").get();
	assert.equal(route.store_id, "sto_target");
	assert.equal(route.previous_store_id, "default");
	const same = await routeSwitch.switchRoute(env, actor, "mail", { storeId: "sto_target" }, ORIGIN);
	assert.equal(same.status, 409);
	const unknown = await routeSwitch.switchRoute(env, actor, "mail", { storeId: "sto_nope" }, ORIGIN);
	assert.equal(unknown.status, 404);

	const moved = await routeSwitch.switchRoute(env, actor, "mail", { storeId: "sto_other", migrate: false }, ORIGIN);
	assert.equal(moved.ok, true);
	assert.equal(moved.migrationId, null);
	const chained = env.DB.db.prepare("SELECT * FROM storage_routes WHERE object_class = 'mail'").get();
	assert.equal(chained.previous_store_id, "sto_target");
	const blocked = await routeSwitch.switchRoute(env, actor, "mail", { storeId: "default" }, ORIGIN);
	assert.equal(blocked.status, 409, "objects on sto_target would drop out of the read chain");
	const later = await routeSwitch.switchRoute(env, actor, "mail", { storeId: "sto_other", migrate: true }, ORIGIN);
	assert.equal(later.ok, true, "copying the leftovers later is allowed");
	await drain(env, queue);
	assert.equal(asText(fake.buckets.get("kite-other").objects.get("inbound/m1.eml")), "raw m1");
	const audit = env.DB.db.prepare("SELECT action FROM audit_logs ORDER BY created_at").all();
	assert.ok(audit.filter((row) => row.action === "storage.route_switched").length >= 2);
});

test("routing Drive needs a store browsers may upload to", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_target", "kite-target");
	fake.buckets.get("kite-target").cors = null;
	const refused = await routeSwitch.switchRoute(env, { id: "owner" }, "drive", { storeId: "sto_target" }, ORIGIN);
	assert.equal(refused.ok, false);
	assert.equal(refused.status, 422);
	assert.match(refused.error, /CORS/);
	const applied = await stores.applyStoreCors(env, "sto_target", ORIGIN);
	assert.equal(applied.ok, true);
	assert.equal(applied.cors, true);
	const switched = await routeSwitch.switchRoute(env, { id: "owner" }, "drive", { storeId: "sto_target" }, ORIGIN);
	assert.equal(switched.ok, true);
});
