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
	const done = await lib.autoSetup.setUpDirectUploadsAtInstall(env, actor, APP_ORIGIN, FAST);
	assert.deepEqual(done, { ok: true });
	assert.equal(state(env).setup.source, "install");
	env.DB.db.exec("DELETE FROM storage_stores");
	cf.state.denied.add("listAccounts");
	const refused = await lib.autoSetup.setUpDirectUploadsAtInstall(env, actor, APP_ORIGIN, FAST);
	assert.equal(refused.ok, false);
	assert.match(refused.message, /Account Settings: Read/);
	assert.equal(state(env).setup.ok, false);
	assert.equal(state(env).setup.source, "install");
	const { env: plain } = await setup(t, { CLOUDFLARE_API_TEST_ORIGIN: "" });
	assert.equal(await lib.autoSetup.setUpDirectUploadsAtInstall(plain, actor, APP_ORIGIN, FAST), null, "local files");
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
