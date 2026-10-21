import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { startFakeS3 } from "./support/fake-s3.mjs";
import { migrationsDir } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const lib = await bundleModules("kite-storage-router-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["openFileBucket", "server/runtime/file-bucket.ts"],
	["sealSetting", "src/lib/security/secret-box.ts"],
	["withStorage, createStorageRouter", "src/lib/storage/router.ts"],
	["getStorage, rawEnvOf, storageConnectOrigins", "src/lib/storage/index.ts"],
	["clearStorageConfigCache, loadStorageConfig, CONFIG_TTL_MS", "src/lib/storage/config.ts"],
	[
		"readChain, deleteTargets, activeStoreId, routesUsingStore, keyHint, parseCredentials, environmentStore, environmentClasses, mergeEnvironmentRoutes, storeRecordFromRow",
		"src/lib/storage/config-utils.ts",
	],
	["objectClassOf", "src/lib/storage/object-classes-utils.ts"],
]);

const fake = await startFakeS3({ buckets: ["kite-mail", "kite-drive"] });
const scratch = mkdtempSync(join(tmpdir(), "kite-storage-router-"));
after(async () => {
	await fake.close();
	rmSync(scratch, { recursive: true, force: true });
});

const KEY = "invented-encryption-key-for-router-tests";
let counter = 0;

/** A migrated database, a file bucket as the default store and, optionally, an S3 store row per bucket. */
async function fixture(t, { stores = [], routes = [], extraEnv = {} } = {}) {
	lib.clearStorageConfigCache();
	const db = new lib.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await lib.applyMigrations(db, migrationsDir);
	const env = {
		DB: db,
		BUCKET: lib.openFileBucket(join(scratch, `default-${++counter}`)),
		APP_ENCRYPTION_KEY: KEY,
		STORAGE_ALLOW_INSECURE_ENDPOINT: "1",
		...extraEnv,
	};
	for (const store of stores) await insertStore(env, store);
	for (const [objectClass, storeId, previousStoreId = null] of routes)
		setRoute(db, objectClass, storeId, previousStoreId);
	return env;
}

async function insertStore(env, { id, bucket, endpoint = `http://${fake.endpoint}`, sameAsBinding = 0 }) {
	const credentials = await lib.sealSetting(
		env,
		JSON.stringify({ accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey }),
	);
	env.DB.db
		.prepare(
			`INSERT INTO storage_stores (id, name, provider, endpoint, region, bucket, addressing, credentials, same_as_binding, created_at, updated_at)
			 VALUES (?, ?, 'minio', ?, ?, ?, 'path', ?, ?, 1, 1)`,
		)
		.run(id, `Store ${id}`, endpoint, fake.region, bucket, credentials, sameAsBinding);
}

function setRoute(db, objectClass, storeId, previousStoreId = null) {
	db.db
		.prepare(
			`INSERT INTO storage_routes (object_class, store_id, previous_store_id, updated_at) VALUES (?, ?, ?, 1)
			 ON CONFLICT (object_class) DO UPDATE SET store_id = excluded.store_id, previous_store_id = excluded.previous_store_id`,
		)
		.run(objectClass, storeId, previousStoreId);
}

const fakeHas = (bucket, key) => fake.buckets.get(bucket).objects.has(key);
const text = async (object) => (object ? await object.text() : null);

test("keys are classified by prefix; everything unlisted is system", () => {
	for (const [key, objectClass] of [
		["inbound/a.eml", "mail"],
		["attachments/m/a", "mail"],
		["drafts/x.eml", "mail"],
		["imports/i", "mail"],
		["jmap-uploads/u", "mail"],
		["drive/drv_1", "drive"],
		["backups/b.json", "backups"],
		["avatars/u.webp", "system"],
		["healthcheck/probe", "system"],
		["driver/x", "system"],
	])
		assert.equal(lib.objectClassOf(key), objectClass, key);
});

test("without stores every class reads and writes the default store", async (t) => {
	const env = await fixture(t);
	const routed = lib.withStorage(env);
	await routed.BUCKET.put("inbound/one.eml", "raw mail");
	assert.equal(await text(await env.BUCKET.get("inbound/one.eml")), "raw mail");
	assert.equal(await text(await routed.BUCKET.get("inbound/one.eml")), "raw mail");
	assert.equal((await routed.BUCKET.head("inbound/one.eml")).size, 8);
	await routed.BUCKET.delete("inbound/one.eml");
	assert.equal(await env.BUCKET.get("inbound/one.eml"), null);
	assert.equal(fake.state.requests.length, 0, "the S3 store is never contacted");
});

test("system keys never read the storage config", async (t) => {
	const env = await fixture(t);
	let reads = 0;
	const counted = {
		...env,
		DB: new Proxy(env.DB, { get: (target, p) => (p === "batch" && reads++, Reflect.get(target, p)) }),
	};
	const routed = lib.withStorage(counted);
	await routed.BUCKET.put("avatars/u.webp", "img");
	assert.equal(await text(await routed.BUCKET.get("avatars/u.webp")), "img");
	assert.equal(reads, 0);
	await routed.BUCKET.get("inbound/missing.eml");
	await routed.BUCKET.get("inbound/missing-2.eml");
	assert.equal(reads, 1, "one cached config read for the other classes");
});

test("withStorage is idempotent and leaves every other binding as it was", async (t) => {
	const env = await fixture(t);
	const routed = lib.withStorage(env);
	assert.equal(lib.withStorage(routed), routed);
	assert.equal(lib.withStorage(env), routed);
	assert.equal(routed.DB, env.DB);
	assert.notEqual(routed.BUCKET, env.BUCKET);
	assert.equal(routed.BUCKET, routed.BUCKET);
	assert.equal(lib.rawEnvOf(routed), env);
	assert.equal(lib.rawEnvOf(env), env);
	assert.equal(lib.withStorage({ DB: env.DB }).BUCKET, undefined, "an env without a bucket is returned as is");
});

test("a routed class writes to its store, reads fall back to the default store, deletes reach both routes", async (t) => {
	const env = await fixture(t, { stores: [{ id: "sto_mail", bucket: "kite-mail" }] });
	const routed = lib.withStorage(env);
	await routed.BUCKET.put("inbound/old.eml", "before the switch");
	assert.equal(await text(await env.BUCKET.get("inbound/old.eml")), "before the switch");

	setRoute(env.DB, "mail", "sto_mail", "default");
	lib.clearStorageConfigCache();
	await routed.BUCKET.put("inbound/new.eml", "after the switch", {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { from: "Zoë <zoe@example.com>" },
	});
	assert.ok(fakeHas("kite-mail", "inbound/new.eml"));
	assert.equal(await env.BUCKET.get("inbound/new.eml"), null);
	const fresh = await routed.BUCKET.get("inbound/new.eml");
	assert.equal(await fresh.text(), "after the switch");
	assert.equal(fresh.customMetadata.from, "Zoë <zoe@example.com>");
	assert.equal(await text(await routed.BUCKET.get("inbound/old.eml")), "before the switch", "chain read");
	assert.equal((await routed.BUCKET.head("inbound/old.eml")).size, 17);

	await routed.BUCKET.put("avatars/a.webp", "pinned");
	assert.equal(await text(await env.BUCKET.get("avatars/a.webp")), "pinned", "system stays on the default store");
	await routed.BUCKET.put("drive/drv_1", "drive stays");
	assert.equal(await text(await env.BUCKET.get("drive/drv_1")), "drive stays", "unrouted classes stay");

	await routed.BUCKET.delete(["inbound/old.eml", "inbound/new.eml", "avatars/a.webp"]);
	assert.equal(await env.BUCKET.get("inbound/old.eml"), null);
	assert.ok(!fakeHas("kite-mail", "inbound/new.eml"));
	assert.equal(await env.BUCKET.get("avatars/a.webp"), null);
});

test("multipart uploads through the router land on the active store", async (t) => {
	const env = await fixture(t, {
		stores: [{ id: "sto_backups", bucket: "kite-mail" }],
		routes: [["backups", "sto_backups"]],
	});
	const routed = lib.withStorage(env);
	const upload = await routed.BUCKET.createMultipartUpload("backups/b1.json");
	const part1 = await upload.uploadPart(1, "a".repeat(5 * 1024 * 1024));
	const resumed = routed.BUCKET.resumeMultipartUpload("backups/b1.json", upload.uploadId);
	const part2 = await resumed.uploadPart(2, "tail");
	await resumed.complete([part1, part2]);
	assert.equal((await routed.BUCKET.head("backups/b1.json")).size, 5 * 1024 * 1024 + 4);
	assert.ok(fakeHas("kite-mail", "backups/b1.json"));
	const listed = await routed.BUCKET.list({ prefix: "backups/" });
	assert.deepEqual(
		listed.objects.map((object) => object.key),
		["backups/b1.json"],
	);
	await routed.BUCKET.delete("backups/b1.json");
});

test("an object written under a stale config is still found, and a failing store does not hide the default one", async (t) => {
	const env = await fixture(t, {
		stores: [{ id: "sto_mail", bucket: "kite-mail" }],
		routes: [["mail", "sto_mail"]],
	});
	await env.BUCKET.put("inbound/stray.eml", "written by a stale isolate");
	const routed = lib.withStorage(env);
	assert.equal(await text(await routed.BUCKET.get("inbound/stray.eml")), "written by a stale isolate");
	fake.state.denied.add("GetObject");
	t.after(() => fake.state.denied.delete("GetObject"));
	assert.equal(await text(await routed.BUCKET.get("inbound/stray.eml")), "written by a stale isolate");
	await assert.rejects(routed.BUCKET.get("inbound/only-on-s3.eml"), /Access Denied|AccessDenied/);
});

test("the config is cached for 30 seconds and a save clears it", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const env = await fixture(t, { stores: [{ id: "sto_mail", bucket: "kite-mail" }] });
	const routed = lib.withStorage(env);
	await routed.BUCKET.put("inbound/a.eml", "a");
	assert.equal(await text(await env.BUCKET.get("inbound/a.eml")), "a");
	setRoute(env.DB, "mail", "sto_mail");
	await routed.BUCKET.put("inbound/b.eml", "b");
	assert.ok(await env.BUCKET.get("inbound/b.eml"), "still the cached config");
	t.mock.timers.tick(lib.CONFIG_TTL_MS + 1);
	await routed.BUCKET.put("inbound/c.eml", "c");
	assert.ok(fakeHas("kite-mail", "inbound/c.eml"), "the next read after the TTL sees the route");
	setRoute(env.DB, "mail", "default");
	lib.clearStorageConfigCache();
	await routed.BUCKET.put("inbound/d.eml", "d");
	assert.ok(await env.BUCKET.get("inbound/d.eml"), "clearing the cache applies a save at once");
});

test("a failed config read uses the last known config, or the default store when there is none", async (t) => {
	const env = await fixture(t, {
		stores: [{ id: "sto_mail", bucket: "kite-mail" }],
		routes: [["mail", "sto_mail"]],
	});
	let failing = true;
	const flaky = {
		...env,
		DB: new Proxy(env.DB, {
			get(target, property) {
				if (property === "batch" && failing) return async () => Promise.reject(new Error("D1_ERROR: network"));
				return Reflect.get(target, property);
			},
		}),
	};
	const routed = lib.withStorage(flaky);
	await routed.BUCKET.put("inbound/during-outage.eml", "kept");
	assert.equal(await text(await env.BUCKET.get("inbound/during-outage.eml")), "kept", "never bounced");

	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	failing = false;
	t.mock.timers.tick(lib.CONFIG_TTL_MS);
	await routed.BUCKET.put("inbound/healthy.eml", "routed");
	assert.ok(fakeHas("kite-mail", "inbound/healthy.eml"));
	failing = true;
	t.mock.timers.tick(lib.CONFIG_TTL_MS + 1);
	await routed.BUCKET.put("inbound/stale.eml", "last known");
	assert.ok(fakeHas("kite-mail", "inbound/stale.eml"), "the last known config is used");
});

test("a database without migration 0065 reads as every class on the default store", async (t) => {
	lib.clearStorageConfigCache();
	const db = new lib.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	const config = await lib.loadStorageConfig({ DB: db });
	assert.equal(config.stores.size, 0);
	assert.equal(config.routes.size, 0);
});

test("the endpoint guard runs on every load: without the dev flag an http loopback store is blocked", async (t) => {
	const env = await fixture(t, {
		stores: [{ id: "sto_mail", bucket: "kite-mail" }],
		routes: [["mail", "sto_mail"]],
		extraEnv: { STORAGE_ALLOW_INSECURE_ENDPOINT: undefined },
	});
	const storage = await lib.getStorage(env);
	assert.match(storage.config.stores.get("sto_mail").blocked, /Private and local addresses/);
	assert.equal(storage.store("sto_mail"), null);
	assert.equal(storage.storeFor("mail").id, "default", "writes fall back to the default store");
	const before = fake.state.requests.length;
	await lib.withStorage(env).BUCKET.put("inbound/guarded.eml", "x");
	assert.equal(fake.state.requests.length, before, "a blocked store is never contacted");
});

test("connect origins list presign-capable stores, and R2 keys for the binding sign the default store", async (t) => {
	const env = await fixture(t, {
		stores: [
			{ id: "sto_drive", bucket: "kite-drive" },
			{ id: "sto_r2keys", bucket: "kite-raw", endpoint: "abc123.r2.cloudflarestorage.com", sameAsBinding: 1 },
		],
		routes: [["drive", "sto_drive"]],
	});
	const storage = await lib.getStorage(env);
	assert.deepEqual(await lib.storageConnectOrigins(env), [
		"https://abc123.r2.cloudflarestorage.com",
		`http://${fake.endpoint}`,
	]);
	assert.equal(storage.store("default").capabilities.presign, true);
	assert.equal(storage.store("sto_r2keys"), null, "R2 keys for the binding are not a routable store");
	const url = new URL(
		await storage.store("default").signer.presignGet("drive/drv_1", {
			expiresIn: 300,
			filename: "a.pdf",
			disposition: "attachment",
			contentType: "application/octet-stream",
		}),
	);
	assert.equal(url.host, "abc123.r2.cloudflarestorage.com");
	assert.equal(url.pathname, "/kite-raw/drive/drv_1");
	const node = await lib.getStorage({ ...env, KITE_RUNTIME: "node" });
	assert.ok(node);
});

test("the read chain, delete targets and active store skip unusable stores", () => {
	const store = (id, extra = {}) => [id, { id, blocked: null, sameAsBinding: false, ...extra }];
	const config = {
		stores: new Map([
			store("sto_a"),
			store("sto_b"),
			store("sto_blocked", { blocked: "no" }),
			store("sto_keys", { sameAsBinding: true }),
		]),
		routes: new Map([
			["mail", { objectClass: "mail", storeId: "sto_b", previousStoreId: "sto_a" }],
			["drive", { objectClass: "drive", storeId: "sto_blocked", previousStoreId: null }],
			["backups", { objectClass: "backups", storeId: "sto_gone", previousStoreId: "default" }],
		]),
	};
	assert.deepEqual(lib.readChain(config, "mail"), ["sto_b", "sto_a", "default"]);
	assert.deepEqual(lib.deleteTargets(config, "mail"), ["sto_b", "sto_a"]);
	assert.deepEqual(lib.readChain(config, "drive"), ["default"]);
	assert.deepEqual(lib.deleteTargets(config, "drive"), ["default"]);
	assert.equal(lib.activeStoreId(config, "drive"), "default");
	assert.equal(lib.activeStoreId(config, "mail"), "sto_b");
	assert.equal(lib.activeStoreId(config, "system"), "default");
	assert.deepEqual(lib.readChain(config, "backups"), ["default"]);
	assert.deepEqual(lib.readChain(config, "system"), ["default"]);
	assert.deepEqual(lib.deleteTargets(config, "system"), ["default"]);
	assert.deepEqual(lib.routesUsingStore(config, "sto_a"), ["mail"]);
	assert.deepEqual(lib.routesUsingStore(config, "sto_keys"), []);
});

test("credentials helpers return only a key hint and refuse malformed values", () => {
	assert.equal(lib.keyHint("AKIAFAKEKITE0001"), "0001");
	assert.equal(lib.keyHint("abcd"), "");
	assert.deepEqual(lib.parseCredentials('{"accessKeyId":"a","secretAccessKey":"b"}'), {
		accessKeyId: "a",
		secretAccessKey: "b",
	});
	assert.throws(() => lib.parseCredentials("not json"), /unreadable/);
	assert.throws(() => lib.parseCredentials('{"accessKeyId":"a"}'), /incomplete/);
	assert.throws(() => lib.parseCredentials(null), /unreadable/);
});

test("STORAGE_S3_* describe a read-only store that takes only the classes no saved route names", () => {
	assert.equal(lib.environmentStore({}), null);
	assert.equal(lib.environmentStore({ STORAGE_S3_ENDPOINT: "s3.example.com", STORAGE_S3_BUCKET: "b" }), null);
	const store = lib.environmentStore({
		STORAGE_S3_ENDPOINT: "http://minio:9000",
		STORAGE_S3_BUCKET: "kite",
		STORAGE_S3_ACCESS_KEY_ID: "invented-id",
		STORAGE_S3_SECRET_ACCESS_KEY: "invented-secret",
	});
	assert.deepEqual(store.location, {
		endpoint: "minio:9000",
		scheme: "http",
		region: "us-east-1",
		bucket: "kite",
		addressing: "path",
	});
	assert.equal(store.source, "environment");
	assert.equal(store.sealedCredentials, "");
	assert.equal(
		lib.environmentStore({
			STORAGE_S3_ENDPOINT: "s3.eu-central-1.amazonaws.com",
			STORAGE_S3_BUCKET: "kite",
			STORAGE_S3_ACCESS_KEY_ID: "i",
			STORAGE_S3_SECRET_ACCESS_KEY: "s",
			STORAGE_S3_ADDRESSING: "virtual",
		}).location.addressing,
		"virtual",
	);
	assert.deepEqual(lib.environmentClasses("mail, drive,system,,backups"), ["mail", "drive", "backups"]);
	assert.deepEqual(lib.environmentClasses(undefined), []);
	const routes = lib.mergeEnvironmentRoutes(
		new Map([["mail", { objectClass: "mail", storeId: "default", previousStoreId: null }]]),
		["mail", "drive"],
	);
	assert.equal(routes.get("mail").storeId, "default");
	assert.equal(routes.get("drive").storeId, "sto_env");
	assert.equal(
		lib.storeRecordFromRow({ provider: "gcs", id: "x", endpoint: "e", region: "r", bucket: "b" }),
		null,
		"an unknown provider is ignored",
	);
});
