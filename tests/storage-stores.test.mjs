import assert from "node:assert/strict";
import test from "node:test";
import { APP_ORIGIN, loadStorageServices } from "./support/storage-services.mjs";

const { lib, fake, fixture, addStore } = await loadStorageServices("kite-storage-stores-", [
	"kite-store",
	"kite-spare",
]);
const { stores, routeSwitch } = lib;
const actor = { id: "owner" };

const form = (overrides = {}) => ({
	name: "Fake MinIO",
	provider: "minio",
	endpoint: fake.url,
	region: fake.region,
	bucket: "kite-store",
	addressing: "path",
	accessKeyId: fake.accessKeyId,
	secretAccessKey: fake.secretAccessKey,
	...overrides,
});

const rows = (env) => env.DB.db.prepare("SELECT * FROM storage_stores").all();
const audits = (env) => env.DB.db.prepare("SELECT action, metadata FROM audit_logs ORDER BY created_at").all();
const step = (report, id) => report.steps.find((entry) => entry.id === id);

test("saving a store is refused without APP_ENCRYPTION_KEY, before any request is made", async (t) => {
	const { env } = await fixture(t, { APP_ENCRYPTION_KEY: "" });
	const before = fake.state.requests.length;
	const result = await stores.createStore(env, actor, form(), APP_ORIGIN);
	assert.equal(result.ok, false);
	assert.equal(result.status, 409);
	assert.match(result.error, /APP_ENCRYPTION_KEY/);
	assert.equal(fake.state.requests.length, before);
	assert.equal(rows(env).length, 0);
	assert.equal((await stores.storageOverview(env)).encryptionReady, false);
});

test("a store that passes the checks is saved sealed, audited, and reported without its secret", async (t) => {
	const { env } = await fixture(t);
	const result = await stores.createStore(env, actor, form(), APP_ORIGIN);
	assert.equal(result.ok, true, result.error);
	assert.equal(result.report.ok, true);
	assert.equal(result.report.cors, false, "the bucket has no CORS rule yet");
	assert.equal(step(result.report, "cors_preflight").status, "failed");
	assert.ok(step(result.report, "cors_preflight").fix);
	const [row] = rows(env);
	assert.match(row.credentials, /^enc:v1:/);
	assert.ok(!row.credentials.includes(fake.secretAccessKey));
	assert.equal(row.endpoint, `http://${fake.endpoint}`);
	assert.equal(row.status, "ok");
	assert.equal(result.store.keyHint, fake.accessKeyId.slice(-4));
	const overview = await stores.storageOverview(env);
	const json = JSON.stringify(overview);
	assert.ok(!json.includes(fake.secretAccessKey));
	assert.ok(!json.includes(fake.accessKeyId));
	assert.equal(overview.defaultStore.name, "Local files");
	assert.equal(overview.stores[0].keyHint, fake.accessKeyId.slice(-4));
	assert.deepEqual(
		overview.routes.map((route) => [route.objectClass, route.storeId]),
		[
			["mail", "default"],
			["drive", "default"],
			["backups", "default"],
		],
	);
	const [audit] = audits(env);
	assert.equal(audit.action, "storage.store_created");
	assert.ok(!audit.metadata.includes(fake.secretAccessKey));
	const probes = [...fake.buckets.get("kite-store").objects.keys()];
	assert.deepEqual(probes, [], "probe objects are deleted again");
});

test("a wrong secret answers 422 with the failing step and its fix, and nothing is saved", async (t) => {
	const { env } = await fixture(t);
	const result = await stores.createStore(env, actor, form({ secretAccessKey: "not-the-right-secret" }), APP_ORIGIN);
	assert.equal(result.ok, false);
	assert.equal(result.status, 422);
	const bucket = step(result.report, "bucket");
	assert.equal(bucket.status, "failed");
	assert.match(`${bucket.detail} ${bucket.fix ?? ""}`, /secret|signature/i);
	assert.equal(step(result.report, "write").status, "skipped");
	assert.equal(rows(env).length, 0);
});

test("the endpoint guard refuses http and local hosts unless the dev flags allow them", async (t) => {
	const { env } = await fixture(t, { STORAGE_ALLOW_INSECURE_ENDPOINT: "", STORAGE_ALLOW_PRIVATE_ENDPOINTS: "" });
	const result = await stores.createStore(env, actor, form(), APP_ORIGIN);
	assert.equal(result.status, 422);
	assert.equal(step(result.report, "endpoint").status, "failed");
	assert.equal(step(result.report, "bucket").status, "skipped");
	const parsed = await stores.createStore(env, actor, form({ endpoint: "https://s3.example.com/bucket" }), APP_ORIGIN);
	assert.equal(parsed.status, 400, "a path in the endpoint is refused before any check");
	const binding = await stores.createStore(env, actor, form({ sameAsBinding: true }), APP_ORIGIN);
	assert.equal(binding.status, 400, "only R2 keys can sign for the default store");
});

test("a saved store that later resolves to a blocked endpoint is never contacted", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_a", "kite-store");
	delete env.STORAGE_ALLOW_INSECURE_ENDPOINT;
	delete env.STORAGE_ALLOW_PRIVATE_ENDPOINTS;
	lib.config.clearStorageConfigCache();
	const overview = await stores.storageOverview(env);
	assert.match(overview.stores[0].blocked, /not allowed|https/);
	const before = fake.state.requests.length;
	const cors = await stores.applyStoreCors(env, "sto_a", APP_ORIGIN);
	assert.equal(cors.status, 409);
	const route = await routeSwitch.switchRoute(env, actor, "mail", { storeId: "sto_a" }, APP_ORIGIN);
	assert.equal(route.status, 409);
	assert.equal(fake.state.requests.length, before);
});

test("an edit keeps the saved key pair, re-validates only what changes, and audits", async (t) => {
	const { env } = await fixture(t);
	const created = await stores.createStore(env, actor, form(), APP_ORIGIN);
	const id = created.store.id;
	const sealed = rows(env)[0].credentials;
	const renamed = await stores.updateStore(env, actor, id, { name: "Renamed" }, APP_ORIGIN);
	assert.equal(renamed.ok, true);
	assert.equal(renamed.report, null, "a rename runs no checks");
	assert.equal(rows(env)[0].credentials, sealed);
	const moved = await stores.updateStore(env, actor, id, { bucket: "kite-missing" }, APP_ORIGIN);
	assert.equal(moved.status, 422);
	assert.equal(rows(env)[0].bucket, "kite-store");
	const spare = await stores.updateStore(env, actor, id, { bucket: "kite-spare" }, APP_ORIGIN);
	assert.equal(spare.ok, true);
	assert.equal(spare.report.ok, true);
	assert.equal(rows(env)[0].credentials, sealed, "the key pair was not re-entered");
	const rekeyed = await stores.updateStore(
		env,
		actor,
		id,
		{ accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey },
		APP_ORIGIN,
	);
	assert.equal(rekeyed.ok, true);
	assert.notEqual(rows(env)[0].credentials, sealed, "new credentials are sealed again");
	assert.deepEqual(
		audits(env).map((row) => row.action),
		["storage.store_created", "storage.store_updated", "storage.store_updated", "storage.store_updated"],
	);
	const half = await stores.updateStore(env, actor, id, { accessKeyId: "AKIAONLYHALF" }, APP_ORIGIN);
	assert.equal(half.status, 400);
	assert.equal((await stores.updateStore(env, actor, "sto_nope", {}, APP_ORIGIN)).status, 404);
});

test("Test records the outcome on the store", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_a", "kite-store");
	fake.state.denied.add("PutObject");
	const failed = await stores.testStore(env, "sto_a", APP_ORIGIN);
	assert.equal(failed.ok, true);
	assert.equal(failed.report.ok, false);
	assert.match(step(failed.report, "write").fix, /PutObject/);
	assert.equal(rows(env)[0].status, "error");
	assert.match(rows(env)[0].last_error, /write|upload|Put/i);
	fake.state.denied.clear();
	const passed = await stores.testStore(env, "sto_a", APP_ORIGIN);
	assert.equal(passed.report.ok, true);
	assert.equal(rows(env)[0].status, "ok");
	assert.equal(rows(env)[0].last_error, null);
});

test("deleting a store is refused while a route, a Drive file or a running migration uses it", async (t) => {
	const { env, queue } = await fixture(t);
	await addStore(env, "sto_a", "kite-store");
	const switched = await routeSwitch.switchRoute(env, actor, "mail", { storeId: "sto_a", migrate: true }, APP_ORIGIN);
	assert.equal(switched.ok, true);
	const routed = await stores.deleteStore(env, actor, "sto_a");
	assert.equal(routed.status, 409);
	assert.match(routed.error, /mail/);
	env.DB.db.prepare("DELETE FROM storage_routes").run();
	lib.config.clearStorageConfigCache();
	const migrating = await stores.deleteStore(env, actor, "sto_a");
	assert.equal(migrating.status, 409);
	assert.match(migrating.error, /migration/);
	env.DB.db.prepare("UPDATE storage_migrations SET status = 'cancelled'").run();
	queue.length = 0;
	env.DB.db
		.prepare(
			`INSERT INTO drive_items (id, owner_id, kind, name, size, store_id, object_key, status, created_at, updated_at)
			 VALUES ('drv_a', 'owner', 'file', 'a.txt', 1, 'sto_a', 'drive/drv_a', 'ready', 1, 1)`,
		)
		.run();
	const drive = await stores.deleteStore(env, actor, "sto_a");
	assert.equal(drive.status, 409);
	assert.match(drive.error, /Drive/);
	env.DB.db.prepare("DELETE FROM drive_items").run();
	const deleted = await stores.deleteStore(env, actor, "sto_a");
	assert.equal(deleted.ok, true);
	assert.equal(rows(env).length, 0);
	assert.equal(audits(env).at(-1).action, "storage.store_deleted");
	assert.equal((await stores.deleteStore(env, actor, "sto_a")).status, 404);
});

test("lifecycle rules are added only to a bucket that has none, on providers that allow it", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_a", "kite-store");
	assert.equal((await stores.applyStoreLifecycle(env, "sto_a")).ok, true);
	assert.match(fake.buckets.get("kite-store").lifecycle ?? "", /AbortIncompleteMultipartUpload/);
	const again = await stores.applyStoreLifecycle(env, "sto_a");
	assert.equal(again.status, 409);
	env.DB.db.prepare("UPDATE storage_stores SET provider = 'b2'").run();
	lib.config.clearStorageConfigCache();
	assert.equal((await stores.applyStoreLifecycle(env, "sto_a")).status, 409);
	assert.equal((await stores.applyStoreCors(env, "sto_a", APP_ORIGIN)).status, 409, "B2 gets a snippet instead");
});

test("the STORAGE_S3_* store is listed read-only and can be routed to", async (t) => {
	const { env } = await fixture(t, {
		STORAGE_S3_ENDPOINT: fake.url,
		STORAGE_S3_REGION: fake.region,
		STORAGE_S3_BUCKET: "kite-spare",
		STORAGE_S3_ACCESS_KEY_ID: fake.accessKeyId,
		STORAGE_S3_SECRET_ACCESS_KEY: fake.secretAccessKey,
		STORAGE_S3_CLASSES: "backups",
	});
	const overview = await stores.storageOverview(env);
	const environment = overview.stores.find((store) => store.source === "environment");
	assert.equal(environment.id, "sto_env");
	assert.equal(overview.routes.find((route) => route.objectClass === "backups").storeId, "sto_env");
	assert.ok(!JSON.stringify(overview).includes(fake.secretAccessKey));
	assert.equal((await stores.updateStore(env, actor, "sto_env", { name: "x" }, APP_ORIGIN)).status, 409);
	assert.equal((await stores.deleteStore(env, actor, "sto_env")).status, 409);
	const switched = await routeSwitch.switchRoute(env, actor, "mail", { storeId: "sto_env" }, APP_ORIGIN);
	assert.equal(switched.ok, true, switched.error);
});
