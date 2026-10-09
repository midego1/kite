import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { planDeployment, recordDeployment } from "../scripts/deploy/deploy-record-utils.mjs";

const fixture = (name) =>
	JSON.parse(readFileSync(new URL(`./fixtures/deploy-record/${name}.json`, import.meta.url), "utf8"));

function withCheck(name, patch) {
	const event = fixture(name);
	Object.assign(event.check_run, patch);
	return event;
}

test("success on production plans a production deployment", () => {
	const event = fixture("check-run-success");
	const plan = planDeployment(event);
	assert.equal(plan.environment, "production");
	assert.equal(plan.state, "success");
	assert.equal(plan.script, "kite");
	assert.equal(plan.sha, event.check_run.head_sha);
	assert.equal(plan.buildId, event.check_run.external_id);
	assert.equal(plan.versionId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
	assert.equal(plan.logUrl, event.check_run.details_url);
});

test("failure and timed_out map to failure, cancelled to error", () => {
	assert.equal(planDeployment(fixture("check-run-failure")).state, "failure");
	assert.equal(planDeployment(withCheck("check-run-success", { conclusion: "timed_out" })).state, "failure");
	assert.equal(planDeployment(withCheck("check-run-success", { conclusion: "cancelled" })).state, "error");
});

test("other conclusions are skipped", () => {
	for (const conclusion of ["neutral", "skipped", "action_required", null]) {
		const plan = planDeployment(withCheck("check-run-success", { conclusion }));
		assert.equal(plan.skip, true);
		assert.ok(plan.reason);
	}
});

test("foreign apps and other check names are skipped with a reason", () => {
	const other = planDeployment(fixture("check-run-other-app"));
	assert.equal(other.skip, true);
	assert.ok(other.reason);
	const renamed = planDeployment(withCheck("check-run-success", { name: "build" }));
	assert.equal(renamed.skip, true);
	assert.ok(renamed.reason);
});

test("preview builds go to preview/<script>", () => {
	assert.equal(planDeployment(fixture("check-run-preview")).environment, "preview/kite");
});

test("a production build of another script is production/<script>", () => {
	const event = withCheck("check-run-success", {
		name: "Workers Builds: kite-email-relay",
		details_url: fixture("check-run-success").check_run.details_url.replace("/kite/", "/kite-email-relay/"),
	});
	const plan = planDeployment(event);
	assert.equal(plan.script, "kite-email-relay");
	assert.equal(plan.environment, "production/kite-email-relay");
});

test("a missing version id is tolerated", () => {
	const plan = planDeployment(withCheck("check-run-success", { output: { summary: "no version" } }));
	assert.equal(plan.versionId, null);
});

function fakeFetch(existing) {
	const calls = [];
	const fn = async (url, init = {}) => {
		const method = init.method ?? "GET";
		calls.push({
			method,
			url: String(url),
			body: init.body ? JSON.parse(init.body) : undefined,
			headers: init.headers,
		});
		const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
		if (method === "GET") return json(existing);
		if (String(url).endsWith("/deployments")) return json({ id: 77 }, 201);
		return json({ id: 1 }, 201);
	};
	return { fn, calls };
}

test("new build: lists, creates one deployment, then one status", async () => {
	const plan = planDeployment(fixture("check-run-success"));
	const { fn, calls } = fakeFetch([]);
	await recordDeployment(plan, { fetch: fn, token: "t", repo: "example/kite" });
	assert.deepEqual(
		calls.map((c) => c.method),
		["GET", "POST", "POST"],
	);
	assert.match(calls[0].url, /\/repos\/example\/kite\/deployments\?/);
	assert.match(calls[0].url, new RegExp(`sha=${plan.sha}`));
	assert.match(calls[0].url, /environment=production/);
	assert.deepEqual(calls[1].body, {
		ref: plan.sha,
		environment: "production",
		auto_merge: false,
		required_contexts: [],
		production_environment: true,
		transient_environment: false,
		description: plan.description,
		payload: {
			buildId: plan.buildId,
			versionId: plan.versionId,
			script: "kite",
		},
	});
	assert.match(calls[2].url, /\/deployments\/77\/statuses$/);
	assert.equal(calls[2].body.state, "success");
	assert.equal(calls[2].body.log_url, plan.logUrl);
});

test("existing deployment: no deployment POST, exactly one status POST", async () => {
	const plan = planDeployment(fixture("check-run-success"));
	const { fn, calls } = fakeFetch([
		{ id: 5, payload: { buildId: "other" } },
		{ id: 9, payload: { buildId: plan.buildId } },
	]);
	await recordDeployment(plan, { fetch: fn, token: "t", repo: "example/kite" });
	const posts = calls.filter((c) => c.method === "POST");
	assert.equal(posts.length, 1);
	assert.match(posts[0].url, /\/deployments\/9\/statuses$/);
});

test("preview deployments are not production environments", async () => {
	const plan = planDeployment(fixture("check-run-preview"));
	const { fn, calls } = fakeFetch([]);
	await recordDeployment(plan, { fetch: fn, token: "t", repo: "example/kite" });
	assert.equal(calls[1].body.production_environment, false);
});

test("a failed API call throws without leaking the token", async () => {
	const plan = planDeployment(fixture("check-run-success"));
	const fn = async () => new Response("nope", { status: 403 });
	await assert.rejects(
		recordDeployment(plan, { fetch: fn, token: "secret-tok", repo: "a/b" }),
		(error) => !String(error.message).includes("secret-tok"),
	);
});

test("a matching build on a later page is found, not duplicated", async () => {
	const plan = planDeployment(fixture("check-run-success"));
	const calls = [];
	const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, payload: { buildId: `other-${i}` } }));
	const fn = async (url, init = {}) => {
		const method = init.method ?? "GET";
		calls.push({ method, url: String(url) });
		const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
		if (method === "GET") {
			const page = new URL(String(url)).searchParams.get("page") ?? "1";
			return json(page === "1" ? page1 : [{ id: 900, payload: { buildId: plan.buildId } }]);
		}
		return json({ id: 1 }, 201);
	};
	await recordDeployment(plan, { fetch: fn, token: "t", repo: "example/kite" });
	const posts = calls.filter((c) => c.method === "POST");
	assert.equal(posts.length, 1);
	assert.match(posts[0].url, /\/deployments\/900\/statuses$/);
	assert.ok(calls.some((c) => /page=2/.test(c.url)));
});

test("hitting the page cap without exhausting history fails closed and never POSTs", async () => {
	const plan = planDeployment(fixture("check-run-success"));
	const calls = [];
	const fn = async (url, init = {}) => {
		const method = init.method ?? "GET";
		calls.push({ method, url: String(url) });
		const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, payload: { buildId: `other-${i}` } }));
		return new Response(JSON.stringify(method === "GET" ? page : { id: 1 }), { status: 200 });
	};
	await assert.rejects(recordDeployment(plan, { fetch: fn, token: "t", repo: "example/kite" }), /pagination cap/);
	assert.equal(calls.filter((c) => c.method === "POST").length, 0);
	assert.equal(calls.length, 50);
});
