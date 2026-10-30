import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { root } from "./support/modules-bundle.mjs";
import { APP_ORIGIN, loadStorageServices } from "./support/storage-services.mjs";

const { lib, fake, fixture, addStore } = await loadStorageServices("kite-storage-test-connection-", ["kite-store"], {
	testRoute: "src/app/api/admin/storage/test/route.ts",
});

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

/** Calls the route as a user (or with a token that is no session), from the app's origin. */
async function call(env, userId, body) {
	const headers = { "Content-Type": "application/json", Origin: APP_ORIGIN };
	headers.Authorization = `Bearer ${userId ? await lib.session.createSession(env, userId) : "not-a-session"}`;
	const request = new Request(`${APP_ORIGIN}/api/admin/storage/test`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const response = await lib.testRoute.POST(request);
	const text = await response.text();
	return { status: response.status, cache: response.headers.get("cache-control"), text, body: JSON.parse(text) };
}

/** Everything written to the console while `run` runs, so a test can prove no secret was logged. */
async function consoleOutput(t, run) {
	const lines = [];
	for (const method of ["log", "info", "warn", "error", "debug"])
		t.mock.method(console, method, (...args) => lines.push(args.map(String).join(" ")));
	const result = await run();
	return { result, logged: lines.join("\n") };
}

test("Test connection has exactly the save route's authorization, before any request to the store", async (t) => {
	const { env } = await fixture(t);
	const before = fake.state.requests.length;
	assert.equal((await call(env, null, form())).status, 401, "no valid session");
	assert.equal((await call(env, "second", form())).status, 403, "an admin who is not the primary admin");
	assert.equal(fake.state.requests.length, before, "the store was never contacted");
	assert.equal(audits(env).length, 0);
	// Session requests also need a same-origin header (hasValidSessionMutationOrigin); a bearer token skips that
	// check by design, so the guard is pinned at the source: both routes authorize as a mutation, first thing.
	const guard =
		/^\tconst access = await authorizeStorage\(request, true\);\n\tif \(access\.error\) return access\.error;/m;
	for (const file of ["src/app/api/admin/storage/test/route.ts", "src/app/api/admin/storage/stores/route.ts"])
		assert.match(readFileSync(join(root, file), "utf8"), guard, file);
});

test("a passing test reports every check, saves nothing, cleans up and never returns or logs a secret", async (t) => {
	const { env } = await fixture(t);
	const { result, logged } = await consoleOutput(t, () => call(env, "owner", form()));
	assert.equal(result.status, 200, result.text);
	assert.equal(result.cache, "no-store");
	const { report } = result.body;
	assert.equal(report.ok, true);
	assert.equal(report.cors, false, "the bucket has no CORS rule yet");
	for (const id of ["endpoint", "credentials", "bucket", "write", "read", "list", "delete"])
		assert.equal(step(report, id).status, "ok", id);
	assert.equal(step(report, "cors_preflight").status, "failed");
	assert.match(step(report, "cors_preflight").fix, /rule below/);
	for (const leak of [fake.secretAccessKey, fake.accessKeyId, "X-Amz-Signature", "X-Amz-Credential", fake.url]) {
		assert.ok(!result.text.includes(leak), `the answer does not contain ${leak}`);
		assert.ok(!logged.includes(leak), `the console does not show ${leak}`);
	}
	assert.equal(rows(env).length, 0, "nothing is saved");
	assert.deepEqual([...fake.buckets.get("kite-store").objects.keys()], [], "probe objects are deleted");
	const [audit] = audits(env);
	assert.equal(audit.action, "storage.store_tested");
	const metadata = JSON.parse(audit.metadata);
	assert.equal(metadata.ok, true);
	assert.equal(metadata.bucket, "kite-store");
	assert.equal(metadata.storeId, null);
	assert.ok(!audit.metadata.includes(fake.secretAccessKey));
	assert.ok(!audit.metadata.includes(fake.accessKeyId));
});

test("a wrong secret fails on the credentials step with a hint, and a denied write names the permission", async (t) => {
	const { env } = await fixture(t);
	const wrong = await call(env, "owner", form({ secretAccessKey: "not-the-right-secret" }));
	assert.equal(wrong.status, 200);
	assert.equal(wrong.body.report.ok, false);
	assert.equal(step(wrong.body.report, "endpoint").status, "ok");
	assert.equal(step(wrong.body.report, "credentials").status, "failed");
	assert.match(step(wrong.body.report, "credentials").fix, /secret/i);
	assert.ok(!wrong.text.includes("not-the-right-secret"));
	fake.state.denied.add("PutObject");
	const denied = await call(env, "owner", form({ provider: "r2", region: "auto" }));
	assert.equal(step(denied.body.report, "write").status, "failed");
	assert.match(step(denied.body.report, "write").fix, /Object Read & Write on kite-store/);
	assert.equal(rows(env).length, 0);
});

test("an edit's test uses the saved key pair when the form leaves it blank", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_a", "kite-store");
	const before = rows(env)[0];
	const saved = await call(env, "owner", form({ storeId: "sto_a", accessKeyId: "", secretAccessKey: "" }));
	assert.equal(saved.status, 200, saved.text);
	assert.equal(saved.body.report.ok, true);
	assert.deepEqual(rows(env)[0], before, "the saved store is not touched");
	assert.equal(JSON.parse(audits(env)[0].metadata).storeId, "sto_a");
	assert.equal((await call(env, "owner", form({ storeId: "sto_nope" }))).status, 404);
	assert.equal((await call(env, "owner", form({ accessKeyId: "", secretAccessKey: "" }))).status, 400);
	assert.equal((await call(env, "owner", form({ endpoint: "https://s3.example.com/path" }))).status, 400);
	const spaced = await call(env, "owner", form({ secretAccessKey: "two words" }));
	assert.equal(spaced.status, 400);
	assert.equal(spaced.body.field, "secretAccessKey", "the dialog shows it under the secret field");
	assert.match(spaced.body.error, /contains a space or line break/);
	assert.ok(!spaced.text.includes("two words"));
});

test("the endpoint guard applies, and the test is rate limited per admin", async (t) => {
	const { env } = await fixture(t, { STORAGE_ALLOW_INSECURE_ENDPOINT: "", STORAGE_ALLOW_PRIVATE_ENDPOINTS: "" });
	const before = fake.state.requests.length;
	const blocked = await call(env, "owner", form());
	assert.equal(step(blocked.body.report, "endpoint").status, "failed");
	assert.equal(step(blocked.body.report, "credentials").status, "skipped");
	assert.equal(fake.state.requests.length, before, "a blocked endpoint is never contacted");
	const keys = [];
	env.LOGIN_RATE_LIMIT = { limit: async ({ key }) => (keys.push(key), { success: false }) };
	const limited = await call(env, "owner", form());
	assert.equal(limited.status, 429);
	assert.deepEqual(keys, ["storage-test:owner"]);
	assert.equal(fake.state.requests.length, before);
});
