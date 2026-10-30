import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import { corsRulesForFakeS3, FAKE_R2, FAKE_R2_SECRET, startFakeCloudflareR2 } from "./support/fake-cloudflare-r2.mjs";
import { startFakeS3 } from "./support/fake-s3.mjs";
import { APP_ORIGIN, loadStorageServices } from "./support/storage-services.mjs";

const { lib, fixture } = await loadStorageServices("kite-r2-auto-setup-", ["unused"], {
	autoSetup: "src/lib/storage/auto-setup.ts",
	s3: "src/lib/storage/s3-bucket.ts",
	cloudflareRoute: "src/app/api/admin/storage/cloudflare/route.ts",
	directRoute: "src/app/api/admin/storage/cloudflare/direct-uploads/route.ts",
	bucketsRoute: "src/app/api/admin/storage/cloudflare/buckets/route.ts",
	reminderRoute: "src/app/api/admin/storage/reminder/route.ts",
});

const INITIAL_BUCKETS = ["kite-raw", "kite-media"];
const emptyBucket = () => ({ objects: new Map(), uploads: new Map(), cors: null, lifecycle: null });
const s3 = await startFakeS3({
	buckets: INITIAL_BUCKETS,
	accessKeyId: FAKE_R2.tokenId,
	secretAccessKey: FAKE_R2_SECRET,
});
const cf = await startFakeCloudflareR2({
	buckets: INITIAL_BUCKETS,
	onCreateBucket: (name) => s3.buckets.set(name, emptyBucket()),
	onCors: (bucket, rules) => {
		const target = s3.buckets.get(bucket);
		if (target) target.cors = corsRulesForFakeS3(rules);
	},
});
after(async () => {
	await cf.close();
	await s3.close();
});

const FAST = { attempts: 2, delayMs: 0, sleep: async () => {} };
const actor = { id: "owner" };
const SECRETS = [FAKE_R2.tokenValue, FAKE_R2_SECRET];

/** A migrated install whose Cloudflare API and R2 endpoint are the fakes; both fakes start clean. */
async function setup(t, extraEnv = {}) {
	const context = await fixture(t, { CLOUDFLARE_API_TEST_ORIGIN: cf.origin, R2_S3_TEST_ENDPOINT: s3.url, ...extraEnv });
	cf.state.denied.clear();
	cf.state.delays.clear();
	cf.state.omitTokenValue = false;
	cf.state.tokens.length = 0;
	cf.state.deletedTokens.length = 0;
	cf.state.requests.length = 0;
	cf.state.cors.clear();
	for (const key of [...cf.state.buckets.keys()])
		if (!INITIAL_BUCKETS.includes(key.slice(1))) cf.state.buckets.delete(key);
	s3.state.denied.clear();
	for (const name of [...s3.buckets.keys()]) {
		if (INITIAL_BUCKETS.includes(name)) s3.buckets.set(name, emptyBucket());
		else s3.buckets.delete(name);
	}
	return context;
}

const stores = (env) => env.DB.db.prepare("SELECT * FROM storage_stores").all();
const audits = (env, action) =>
	env.DB.db
		.prepare("SELECT action, metadata FROM audit_logs WHERE action = ? ORDER BY created_at")
		.all(action)
		.map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }));
const state = (env) =>
	JSON.parse(env.DB.db.prepare("SELECT direct_uploads FROM storage_state").get()?.direct_uploads ?? "{}");
const noSecrets = (value, what) => {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	for (const secret of SECRETS) assert.ok(!text.includes(secret), `${what} carries no token value or secret`);
};

test("one click sets up direct uploads: a bucket-only token, the CORS rule, checks and a sealed save", async (t) => {
	const { env } = await setup(t);
	const result = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(
		result.steps.map((step) => [step.id, step.status]),
		[
			["account", "ok"],
			["bucket", "ok"],
			["token", "ok"],
			["cors", "ok"],
			["keys", "ok"],
			["checks", "ok"],
		],
	);
	assert.equal(result.report.cors, true, "the CORS rule Kite set lets browsers upload");
	const [token] = cf.state.tokens;
	assert.deepEqual(token.policies, [
		{
			effect: "allow",
			resources: { [`com.cloudflare.edge.r2.bucket.${FAKE_R2.accountId}_default_kite-raw`]: "*" },
			permission_groups: [{ id: FAKE_R2.itemWriteGroupId }],
		},
	]);
	assert.deepEqual(cf.state.cors.get("kite-raw").rules[0].allowed.origins, [APP_ORIGIN]);
	const [row] = stores(env);
	assert.equal(row.same_as_binding, 1);
	assert.equal(row.provider, "r2");
	assert.equal(row.bucket, "kite-raw");
	assert.match(row.credentials, /^enc:v1:/);
	noSecrets(row.credentials, "the stored row");
	noSecrets(result, "the answer");
	const [audit] = audits(env, "storage.auto_setup");
	assert.equal(audit.metadata.outcome, "set_up");
	assert.equal(audit.metadata.kind, "direct_uploads");
	noSecrets(audit.metadata, "the audit row");
	assert.equal(state(env).setup.ok, true);
	assert.equal(cf.state.deletedTokens.length, 0);
	assert.deepEqual([...s3.buckets.get("kite-raw").objects.keys()], [], "no probe left behind");
});

test("a CF_TOKEN without the token permission is named, nothing is saved, and the manual flow stays", async (t) => {
	const { env } = await setup(t);
	cf.state.denied.add("createToken");
	const result = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal(result.ok, false);
	assert.equal(result.code, "permission");
	assert.equal(result.permission, "Account API Tokens: Edit");
	assert.match(result.error, /Account API Tokens: Edit.*by hand/);
	assert.deepEqual(
		result.steps.map((step) => [step.id, step.status]),
		[
			["account", "ok"],
			["bucket", "ok"],
			["token", "failed"],
			["cors", "skipped"],
			["keys", "skipped"],
			["binding", "skipped"],
			["checks", "skipped"],
		],
	);
	assert.equal(stores(env).length, 0);
	assert.deepEqual(state(env).setup.permission, "Account API Tokens: Edit");
	assert.equal(audits(env, "storage.auto_setup")[0].metadata.failedStep, "token");
});

test("a step after the token fails: the token is deleted again and nothing is saved", async (t) => {
	const { env } = await setup(t);
	s3.state.denied.add("HeadBucket");
	const result = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal(result.ok, false);
	assert.equal(result.steps.find((step) => step.status === "failed").id, "keys");
	assert.deepEqual(cf.state.deletedTokens, [FAKE_R2.tokenId]);
	assert.equal(stores(env).length, 0);
	cf.state.denied.add("putCors");
	s3.state.denied.clear();
	const cors = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal(cors.permission, "Workers R2 Storage: Edit");
	assert.equal(cf.state.deletedTokens.length, 2);
});

test("Create a new R2 bucket: created in the chosen jurisdiction and location, connected and saved", async (t) => {
	const { env } = await setup(t);
	const plan = { sameAsBinding: false, bucket: "kite-drive", jurisdiction: "eu", create: { locationHint: "weur" } };
	const result = await lib.autoSetup.setUpR2(env, actor, APP_ORIGIN, plan, { timing: FAST });
	assert.equal(result.ok, true, result.error);
	const created = cf.state.requests.find((request) => request.operation === "createBucket");
	assert.equal(created.jurisdiction, "eu");
	assert.deepEqual(created.body, { name: "kite-drive", locationHint: "weur" });
	assert.ok(
		cf.state.tokens[0].policies[0].resources[`com.cloudflare.edge.r2.bucket.${FAKE_R2.accountId}_eu_kite-drive`],
	);
	const [row] = stores(env);
	assert.equal(row.name, "Cloudflare R2 kite-drive");
	assert.equal(row.same_as_binding, 0);
	assert.equal(state(env).setup, undefined, "a separate store does not touch the direct-uploads note");
});

test("a taken name answers bucket_exists before any token, and connecting the existing bucket then works", async (t) => {
	const { env } = await setup(t);
	const taken = await lib.autoSetup.setUpR2(
		env,
		actor,
		APP_ORIGIN,
		{ sameAsBinding: false, bucket: "kite-media", jurisdiction: "", create: {} },
		{ timing: FAST },
	);
	assert.equal(taken.ok, false);
	assert.equal(taken.code, "bucket_exists");
	assert.equal(taken.status, 409);
	assert.equal(cf.state.tokens.length, 0);
	const existing = await lib.autoSetup.setUpR2(
		env,
		actor,
		APP_ORIGIN,
		{ sameAsBinding: false, bucket: "kite-media", jurisdiction: "", create: null },
		{ timing: FAST },
	);
	assert.equal(existing.ok, true, existing.error);
	const missing = await lib.autoSetup.setUpR2(
		env,
		actor,
		APP_ORIGIN,
		{ sameAsBinding: false, bucket: "kite-nope", jurisdiction: "", create: null },
		{ timing: FAST },
	);
	assert.match(missing.error, /no bucket named kite-nope/);
});

test("the keys must reach the Worker's own bucket for direct uploads", async (t) => {
	const { env } = await setup(t);
	const bucket = new lib.s3.S3Bucket({
		endpoint: s3.endpoint,
		scheme: "http",
		region: "auto",
		bucket: "kite-raw",
		addressing: "path",
		accessKeyId: FAKE_R2.tokenId,
		secretAccessKey: FAKE_R2_SECRET,
	});
	await assert.rejects(
		lib.autoSetup.checkBindingBucket(env, bucket, "kite-raw"),
		/The Worker's bucket is not kite-raw/,
	);
	env.BUCKET = bucket;
	await lib.autoSetup.checkBindingBucket(env, bucket, "kite-raw");
	assert.deepEqual([...s3.buckets.get("kite-raw").objects.keys()], [], "the binding probe is deleted");
});

test("availability: not off Workers without Cloudflare, and not without an encryption key", async (t) => {
	const { env } = await setup(t, { CLOUDFLARE_API_TEST_ORIGIN: "" });
	assert.equal((await lib.autoSetup.r2AutoSetupAvailability(env)).available, false);
	env.CLOUDFLARE_API_TEST_ORIGIN = cf.origin;
	env.APP_ENCRYPTION_KEY = "";
	const noKey = await lib.autoSetup.r2AutoSetupAvailability(env);
	assert.match(noKey.reason, /APP_ENCRYPTION_KEY/);
	const result = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal(result.code, "unavailable");
	assert.equal(cf.state.requests.length, 0);
});

test("first-run setup turns direct uploads on, and a refusal never fails registration", async (t) => {
	const { env } = await setup(t);
	const done = await lib.autoSetup.setUpDirectUploadsAtInstall(env, actor, APP_ORIGIN, { timing: FAST });
	assert.deepEqual(done, { ok: true });
	assert.equal(state(env).setup.source, "install");
	env.DB.db.exec("DELETE FROM storage_stores");
	cf.state.denied.add("getZone");
	cf.state.denied.add("listAccounts");
	const refused = await lib.autoSetup.setUpDirectUploadsAtInstall(env, actor, APP_ORIGIN, { timing: FAST });
	assert.equal(refused.ok, false);
	assert.match(refused.message, /Account Settings: Read/);
	assert.equal(state(env).setup.ok, false);
	assert.equal(state(env).setup.source, "install");
	const { env: plain } = await setup(t, { CLOUDFLARE_API_TEST_ORIGIN: "" });
	assert.equal(
		await lib.autoSetup.setUpDirectUploadsAtInstall(plain, actor, APP_ORIGIN, { timing: FAST }),
		null,
		"local files",
	);
});

async function call(env, userId, route, method = "POST", body) {
	const request = new Request(`${APP_ORIGIN}/api/admin/storage/cloudflare`, {
		method,
		headers: {
			Authorization: `Bearer ${userId ? await lib.session.createSession(env, userId) : "not-a-session"}`,
			"Content-Type": "application/json",
			Origin: APP_ORIGIN,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const response = await route[method](request);
	const text = await response.text();
	return { status: response.status, text, body: JSON.parse(text) };
}

test("the one-click routes are for the primary admin, validate input, rate limit and never return a secret", async (t) => {
	const { env } = await setup(t);
	for (const [user, status] of [
		[null, 401],
		["second", 403],
	]) {
		assert.equal((await call(env, user, lib.directRoute)).status, status);
		assert.equal((await call(env, user, lib.bucketsRoute, "POST", { bucket: "kite-x" })).status, status);
		assert.equal((await call(env, user, lib.cloudflareRoute, "GET")).status, status);
		assert.equal((await call(env, user, lib.reminderRoute, "POST", { dismissed: true })).status, status);
	}
	assert.equal(cf.state.requests.length, 0);
	const bad = await call(env, "owner", lib.bucketsRoute, "POST", { bucket: "Bad_Name", create: true });
	assert.equal(bad.status, 400);
	assert.equal(bad.body.field, "bucket");
	const choices = await call(env, "owner", lib.cloudflareRoute, "GET");
	assert.equal(choices.status, 200);
	assert.equal(choices.body.accountId, FAKE_R2.accountId);
	assert.deepEqual(
		choices.body.buckets.map((bucket) => bucket.name),
		INITIAL_BUCKETS,
	);
	const created = await call(env, "owner", lib.bucketsRoute, "POST", { bucket: "kite-backups", create: true });
	assert.equal(created.status, 200, created.text);
	assert.equal(created.body.store.bucket, "kite-backups");
	noSecrets(created.text, "the route's answer");
	cf.state.denied.add("listBuckets");
	const refused = await call(env, "owner", lib.cloudflareRoute, "GET");
	assert.equal(refused.body.permission, "Workers R2 Storage: Edit");
	cf.state.denied.clear();
	for (let attempt = 2; attempt <= 5; attempt++)
		await call(env, "owner", lib.bucketsRoute, "POST", { bucket: "kite-media", create: false });
	const before = cf.state.requests.length;
	const limited = await call(env, "owner", lib.directRoute, "POST", {});
	assert.equal(limited.status, 429);
	assert.equal(cf.state.requests.length, before, "a refused attempt reaches no Cloudflare API");
	const rows = audits(env, "storage.auto_setup");
	assert.equal(rows.length, 6, "one row per attempt");
	assert.equal(rows.at(-1).metadata.outcome, "rate_limited");
	for (const row of rows) noSecrets(row.metadata, "an audit row");
});

test("the reminder shows on Cloudflare until direct uploads are on or it is dismissed", async (t) => {
	const { env } = await setup(t);
	delete env.KITE_RUNTIME;
	const reminder = async () => (await lib.stores.storageOverview(env)).directUploadsReminder;
	assert.deepEqual(await reminder(), { show: true, setup: null });
	await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal((await reminder()).show, false, "on now");
	env.DB.db.exec("DELETE FROM storage_stores");
	lib.config.clearStorageConfigCache();
	assert.equal((await reminder()).show, true);
	env.KITE_RUNTIME = "node";
	const dismissed = await call(env, "owner", lib.reminderRoute, "POST", { dismissed: true });
	assert.equal(dismissed.status, 200);
	delete env.KITE_RUNTIME;
	assert.equal((await reminder()).show, false);
	env.KITE_RUNTIME = "node";
	await call(env, "owner", lib.reminderRoute, "POST", { dismissed: false });
	delete env.KITE_RUNTIME;
	assert.equal((await reminder()).show, true);
	env.KITE_RUNTIME = "node";
});

test("before migration 0085 the reminder still shows and dismissing waits for the update", async (t) => {
	const { env } = await setup(t);
	env.DB.db.exec("DROP TABLE storage_state");
	delete env.KITE_RUNTIME;
	assert.deepEqual((await lib.stores.storageOverview(env)).directUploadsReminder, { show: true, setup: null });
	env.KITE_RUNTIME = "node";
	const dismissed = await call(env, "owner", lib.reminderRoute, "POST", { dismissed: true });
	assert.equal(dismissed.status, 409);
	assert.equal(dismissed.body.code, "MIGRATION_PENDING");
	const result = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal(result.ok, true, "the setup itself does not need the note");
});

test("connecting an existing bucket keeps other sites' CORS rules, and a failed setup puts the policy back", async (t) => {
	const { env } = await setup(t);
	const other = { id: "photos-site", allowed: { origins: ["https://photos.example.com"], methods: ["GET"] } };
	cf.state.cors.set("kite-media", { rules: [other] });
	const plan = { sameAsBinding: false, bucket: "kite-media", jurisdiction: "", create: null };
	s3.state.denied.add("HeadBucket");
	const failed = await lib.autoSetup.setUpR2(env, actor, APP_ORIGIN, plan, { timing: FAST });
	assert.equal(failed.ok, false);
	assert.deepEqual(cf.state.cors.get("kite-media"), { rules: [other] }, "restored exactly as it was");
	s3.state.denied.clear();
	const done = await lib.autoSetup.setUpR2(env, actor, APP_ORIGIN, plan, { timing: FAST });
	assert.equal(done.ok, true, done.error);
	const rules = cf.state.cors.get("kite-media").rules;
	assert.deepEqual(rules[0], other, "the other site's rule is still there");
	assert.equal(rules[1].id, "kite-direct-uploads");
	s3.state.denied.add("HeadBucket");
	await lib.autoSetup.setUpR2(env, actor, APP_ORIGIN, { ...plan, bucket: "kite-raw" }, { timing: FAST });
	assert.equal(cf.state.cors.has("kite-raw"), false, "a bucket without a policy is left without one");
	assert.ok(cf.state.requests.some((request) => request.operation === "deleteCors"));
});

const REAL_SLEEP = { attempts: 100, delayMs: 200, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

test("install-time setup ends within its budget: the token is deleted and CORS restored, nothing runs later", async (t) => {
	const { env } = await setup(t);
	s3.state.denied.add("HeadBucket");
	const started = Date.now();
	const result = await lib.autoSetup.setUpDirectUploadsAtInstall(env, actor, APP_ORIGIN, {
		timing: REAL_SLEEP,
		budgetMs: 12_000,
	});
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 12_000, `ended in ${elapsed} ms, inside the budget`);
	assert.ok(elapsed > 4_000, "the keys were waited for until the budget ran low");
	assert.equal(result.ok, false);
	assert.match(result.message, /took too long/);
	assert.deepEqual(cf.state.deletedTokens, [FAKE_R2.tokenId], "no token is left behind");
	assert.equal(cf.state.cors.has("kite-raw"), false, "the CORS policy is back to none");
	assert.equal(stores(env).length, 0);
	const note = state(env).setup;
	assert.equal(note.ok, false);
	assert.equal(note.source, "install");
	assert.match(note.message, /took too long/);
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.deepEqual(state(env).setup, note, "no late finish rewrites the note");
});

test("a token request Cloudflare answers too late is cleaned up by name", async (t) => {
	const { env } = await setup(t);
	cf.state.delays.set("createToken", 10_000);
	const result = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST, budgetMs: 11_000 });
	assert.equal(result.ok, false);
	assert.equal(result.code, "timeout");
	assert.equal(result.steps.find((step) => step.status === "failed").id, "token");
	assert.ok(cf.state.requests.some((request) => request.operation === "listTokens"));
	assert.deepEqual(cf.state.deletedTokens, [FAKE_R2.tokenId], "the token Cloudflare made anyway is deleted");
});

test("a token answered without its value is deleted at once", async (t) => {
	const { env } = await setup(t);
	cf.state.omitTokenValue = true;
	const result = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal(result.ok, false);
	assert.match(result.error, /did not return the new token/);
	assert.deepEqual(cf.state.deletedTokens, [FAKE_R2.tokenId]);
});

test("the account comes from a zone Kite manages, so GET /accounts is not needed", async (t) => {
	const { env } = await setup(t);
	cf.state.denied.add("listAccounts");
	const result = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal(result.ok, true, result.error);
	const zone = cf.state.requests.find((request) => request.operation === "getZone");
	assert.equal(zone.path, "/client/v4/zones/zone-1");
	assert.ok(!cf.state.requests.some((request) => request.operation === "listAccounts"));
	env.CF_ACCOUNT_ID = FAKE_R2.accountId;
	env.DB.db.exec("DELETE FROM storage_stores");
	lib.config.clearStorageConfigCache();
	cf.state.requests.length = 0;
	await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.ok(!cf.state.requests.some((request) => ["getZone", "listAccounts"].includes(request.operation)));
});

test("a second token for a bucket Kite already has a store for is refused before it is made", async (t) => {
	const { env } = await setup(t);
	assert.equal((await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST })).ok, true);
	const plan = { sameAsBinding: false, bucket: "kite-media", jurisdiction: "", create: null };
	assert.equal((await lib.autoSetup.setUpR2(env, actor, APP_ORIGIN, plan, { timing: FAST })).ok, true);
	const tokens = cf.state.tokens.length;
	const again = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal(again.code, "already_connected");
	const store = await lib.autoSetup.setUpR2(env, actor, APP_ORIGIN, plan, { timing: FAST });
	assert.equal(store.code, "already_connected");
	assert.match(store.error, /already has a store for kite-media/);
	assert.equal(cf.state.tokens.length, tokens, "no new token");
});

test("after a successful save, a failing audit or note write is logged, not answered", async (t) => {
	const { env } = await setup(t);
	env.DB.db
		.exec(`CREATE TRIGGER fail_auto_setup_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'storage.auto_setup'
		BEGIN SELECT RAISE(ABORT, 'audit log unavailable'); END;`);
	const logged = [];
	t.mock.method(console, "error", (...args) => logged.push(args.map(String).join(" ")));
	const result = await lib.autoSetup.setUpDirectUploads(env, actor, APP_ORIGIN, {}, { timing: FAST });
	assert.equal(result.ok, true);
	assert.equal(stores(env).length, 1);
	assert.match(logged.join("\n"), /storage.auto_setup_record_failed/);
	noSecrets(logged.join("\n"), "the log");
});

test("the Cloudflare and R2 stand-ins are ignored in production", async (t) => {
	const { env } = await setup(t);
	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	t.after(() => {
		process.env.NODE_ENV = previous;
	});
	const availability = await lib.autoSetup.r2AutoSetupAvailability(env);
	assert.equal(availability.available, false, "a Node install with only the stand-in set has nothing to set up");
	assert.equal(cf.state.requests.length, 0);
});

test("the bucket picker is rate limited per admin", async (t) => {
	const { env } = await setup(t);
	const keys = [];
	env.LOGIN_RATE_LIMIT = { limit: async ({ key }) => (keys.push(key), { success: false }) };
	const limited = await call(env, "owner", lib.cloudflareRoute, "GET");
	assert.equal(limited.status, 429);
	assert.deepEqual(keys, ["storage-r2-buckets:owner"]);
	assert.equal(cf.state.requests.length, 0);
	env.LOGIN_RATE_LIMIT = {
		limit: async () => {
			throw new Error("limiter down");
		},
	};
	const warnings = [];
	t.mock.method(console, "warn", (...args) => warnings.push(args.map(String).join(" ")));
	assert.equal((await call(env, "owner", lib.cloudflareRoute, "GET")).status, 200);
	assert.match(warnings.join("\n"), /storage.r2_listing_limiter_unavailable/);
});
