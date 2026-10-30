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
	assert.equal(metadata.bucket, "kite-store");
	assert.equal(metadata.provider, "minio");
	assert.match(logged, /"event":"storage.store_tested".*"ok":true/);
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

test("an edit's test with a blank key pair is refused once the location changes, before any request", async (t) => {
	const { env } = await fixture(t);
	await addStore(env, "sto_a", "kite-store");
	const before = fake.state.requests.length;
	const blank = { storeId: "sto_a", accessKeyId: "", secretAccessKey: "" };
	for (const change of [
		{ endpoint: "https://s3.example.com" },
		{ bucket: "kite-other" },
		{ region: "eu-west-1" },
		{ addressing: "virtual", bucket: "kite-store" },
		{ provider: "other" },
	]) {
		const refused = await call(env, "owner", form({ ...blank, ...change }));
		assert.equal(refused.status, 400, JSON.stringify(change));
		assert.equal(refused.body.field, "secretAccessKey");
		assert.match(refused.body.error, /again to test a different endpoint, bucket or region/);
	}
	assert.equal(fake.state.requests.length, before, "the saved secret signed nothing");
	assert.equal(audits(env).length, 0, "a refused test is not an attempt");
	const typed = await call(env, "owner", form({ storeId: "sto_a", bucket: "kite-store", region: fake.region }));
	assert.equal(typed.status, 200, "typing the keys again is fine");
});

test("the endpoint guard applies before any request", async (t) => {
	const { env } = await fixture(t, { STORAGE_ALLOW_INSECURE_ENDPOINT: "", STORAGE_ALLOW_PRIVATE_ENDPOINTS: "" });
	const before = fake.state.requests.length;
	const blocked = await call(env, "owner", form());
	assert.equal(step(blocked.body.report, "endpoint").status, "failed");
	assert.equal(step(blocked.body.report, "credentials").status, "skipped");
	assert.equal(fake.state.requests.length, before, "a blocked endpoint is never contacted");
});

test("each admin may test five times a minute, and a limit that cannot be checked refuses", async (t) => {
	const { env } = await fixture(t);
	for (let attempt = 1; attempt <= 5; attempt++) assert.equal((await call(env, "owner", form())).status, 200);
	const before = fake.state.requests.length;
	const limited = await call(env, "owner", form());
	assert.equal(limited.status, 429);
	assert.match(limited.body.error, /wait a minute/);
	assert.equal(fake.state.requests.length, before, "a refused test sends nothing");
	const rows = audits(env).map((row) => JSON.parse(row.metadata));
	assert.equal(rows.length, 6, "one audit row per attempt, the refused one included");
	assert.deepEqual(
		rows.map((row) => row.outcome),
		["passed", "passed", "passed", "passed", "passed", "rate_limited"],
	);
	const { env: other } = await fixture(t);
	other.DB.db.exec("DROP TABLE audit_logs");
	const { result, logged } = await consoleOutput(t, () => call(other, "owner", form()));
	assert.equal(result.status, 503);
	assert.match(logged, /storage.test_limit_unavailable/);
	assert.ok(!logged.includes(fake.secretAccessKey));
});

/** Wraps fetch so a test can answer some store requests itself and see how every one was sent. */
function interceptFetch(t, answer) {
	const real = globalThis.fetch;
	const seen = [];
	t.mock.method(globalThis, "fetch", async (input, init = {}) => {
		const url = String(input instanceof Request ? input.url : input);
		seen.push({ url, method: init.method ?? "GET", redirect: init.redirect, signal: init.signal });
		return (await answer(url, init)) ?? real(input, init);
	});
	return seen;
}

test("no check follows a redirect, and every check request has a deadline", async (t) => {
	const { env } = await fixture(t);
	let redirecting = "HEAD";
	const seen = interceptFetch(t, (url, init) =>
		(init.method ?? "GET") === redirecting
			? new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } })
			: null,
	);
	const result = await call(env, "owner", form());
	const bucket = step(result.body.report, "bucket");
	assert.equal(bucket.status, "failed");
	assert.match(bucket.detail, /another region or needs another endpoint/);
	assert.ok(seen.length > 0);
	assert.ok(!seen.some((entry) => entry.url.includes("169.254.169.254")), "the Location was never requested");
	for (const entry of seen) {
		assert.equal(entry.redirect, "manual", `${entry.method} ${entry.url}`);
		assert.ok(entry.signal, `${entry.method} has a deadline`);
	}
	redirecting = "OPTIONS";
	const preflight = await call(env, "owner", form());
	assert.match(step(preflight.body.report, "cors_preflight").detail, /redirected/);
});

test("a delete that times out is retried, so no probe object is left behind", async (t) => {
	const { env } = await fixture(t);
	let timedOut = 0;
	interceptFetch(t, (url, init) => {
		if (init.method !== "DELETE" || timedOut) return null;
		timedOut++;
		throw new DOMException("The operation timed out.", "TimeoutError");
	});
	const result = await call(env, "owner", form());
	const remove = step(result.body.report, "delete");
	assert.equal(remove.status, "failed");
	assert.match(remove.detail, /did not answer in time/);
	assert.equal(timedOut, 1);
	assert.deepEqual([...fake.buckets.get("kite-store").objects.keys()], [], "the probe was deleted afterwards");
});
