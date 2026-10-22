import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	planRelease,
	publishRelease,
	releaseTag,
	renderPublishedNotes,
} from "../scripts/deploy/release-publish-utils.mjs";

const fixture = (name) =>
	JSON.parse(readFileSync(new URL(`./fixtures/deploy-record/${name}.json`, import.meta.url), "utf8"));

function withCheck(name, patch) {
	const event = fixture(name);
	Object.assign(event.check_run, patch);
	return event;
}

const SHA = fixture("check-run-success").check_run.head_sha;
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

test("a successful production deploy of kite is released at its commit", () => {
	assert.deepEqual(planRelease(fixture("check-run-success")), {
		sha: SHA,
		buildId: fixture("check-run-success").check_run.external_id,
	});
});

test("previews, failures, other Workers and other apps are not released", () => {
	for (const name of ["check-run-preview", "check-run-failure", "check-run-other-app", "check-run-relay-production"]) {
		const plan = planRelease(fixture(name));
		assert.equal(plan.skip, true, name);
		assert.ok(plan.reason, name);
	}
	assert.match(planRelease(fixture("check-run-preview")).reason, /preview\/kite is not the production deploy/);
	assert.match(planRelease(fixture("check-run-relay-production")).reason, /not the production deploy/);
	assert.match(planRelease(withCheck("check-run-success", { conclusion: "cancelled" })).reason, /state is error/);
	assert.equal(planRelease(withCheck("check-run-success", { conclusion: "neutral" })).skip, true);
	assert.match(planRelease(withCheck("check-run-success", { head_sha: "main" })).reason, /not a commit SHA/);
});

test("the tag is v plus a calendar VERSION", () => {
	assert.equal(releaseTag("2026.10.22.1\n"), "v2026.10.22.1");
	assert.throws(() => releaseTag("0.5.0.1"), /not a calendar version/);
	assert.throws(() => releaseTag(""), /\(empty\) is not a calendar version/);
});

const CHANGELOG =
	"# Changelog\n\n## [Unreleased]\n\n## [2026.10.22.1] - 2026-10-22\n\n### Changed\n\n- Releases publish themselves.\n\n## [2026.10.22.0] - 2026-10-22\n\n- Old.\n";

test("published notes are the changelog section, then the commits since the previous release", () => {
	const notes = renderPublishedNotes({
		version: "2026.10.22.1",
		changelog: CHANGELOG,
		base: "v2026.10.22.0",
		subjects: ["feat(release): publish", "fix(release): tag", "chore(release): 2026.10.22.1"],
	});
	assert.equal(
		notes,
		"### Changed\n\n- Releases publish themselves.\n\n## Commits\n\nCompared with v2026.10.22.0.\n\n### Features\n\n- feat(release): publish\n\n### Fixes\n\n- fix(release): tag\n\n### Maintenance\n\n- chore(release): 2026.10.22.1\n\n",
	);
	assert.doesNotMatch(notes, /Review before publishing/);
});

test("a version without a changelog section still gets notes", () => {
	const notes = renderPublishedNotes({ version: "2026.10.23.0", changelog: CHANGELOG, base: "abc", subjects: [] });
	assert.match(notes, /^CHANGELOG\.md has no notes for 2026\.10\.23\.0\./);
	assert.match(notes, /No new commits in this comparison\./);
});

/** A tiny in-memory GitHub: tag refs, annotated tag objects and releases. */
function fakeGitHub({ refs = {}, tagObjects = {}, releases = [] } = {}) {
	const calls = [];
	const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
	const fn = async (url, init = {}) => {
		const method = init.method ?? "GET";
		const { pathname, searchParams } = new URL(String(url));
		const path = pathname.replace(/^\/repos\/example\/kite/, "");
		const body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, body, headers: init.headers, page: searchParams.get("page") });
		const refMatch = /^\/git\/ref\/tags\/(.+)$/.exec(path);
		if (method === "GET" && refMatch) {
			const ref = refs[refMatch[1]];
			return ref ? json({ ref: `refs/tags/${refMatch[1]}`, object: ref }) : json({ message: "Not Found" }, 404);
		}
		const tagMatch = /^\/git\/tags\/(.+)$/.exec(path);
		if (method === "GET" && tagMatch) return json({ object: tagObjects[tagMatch[1]] });
		if (method === "POST" && path === "/git/refs") return json({ ref: body.ref, object: { sha: body.sha } }, 201);
		if (method === "GET" && path === "/releases") {
			const page = Number(searchParams.get("page"));
			return json(releases.slice((page - 1) * 100, page * 100));
		}
		if (method === "POST" && path === "/releases") return json({ id: 501, html_url: "https://example/r/501" }, 201);
		if (method === "PATCH" && path.startsWith("/releases/"))
			return json({ id: Number(path.split("/")[2]), html_url: "https://example/r/draft" });
		return json({ message: "unexpected" }, 500);
	};
	return { fn, calls };
}

const release = (overrides = {}) => ({ sha: SHA, version: "2026.10.22.1\n", notes: "Notes.\n", ...overrides });
const options = (fn) => ({ fetch: fn, token: "tok", repo: "example/kite" });

test("a new version: creates a lightweight tag on the commit, then a published latest release", async () => {
	const { fn, calls } = fakeGitHub();
	const result = await publishRelease(release(), options(fn));
	assert.deepEqual(result, {
		outcome: "published",
		tag: "v2026.10.22.1",
		createdTag: true,
		url: "https://example/r/501",
	});
	assert.deepEqual(
		calls.map((call) => `${call.method} ${call.path}`),
		["GET /git/ref/tags/v2026.10.22.1", "POST /git/refs", "GET /releases", "POST /releases"],
	);
	assert.deepEqual(calls[1].body, { ref: "refs/tags/v2026.10.22.1", sha: SHA });
	assert.deepEqual(calls[3].body, {
		tag_name: "v2026.10.22.1",
		target_commitish: SHA,
		name: "Kite 2026.10.22.1",
		body: "Notes.\n",
		draft: false,
		make_latest: "true",
	});
	assert.equal(calls[0].headers.Authorization, "Bearer tok");
});

test("a draft for the tag is published with the new notes instead of creating a second release", async () => {
	const { fn, calls } = fakeGitHub({
		refs: { "v2026.10.22.1": { type: "commit", sha: SHA } },
		releases: [
			{ id: 3, tag_name: "v2026.10.22.0", draft: false },
			{ id: 7, tag_name: "v2026.10.22.1", draft: true },
		],
	});
	const result = await publishRelease(release(), options(fn));
	assert.equal(result.outcome, "published-draft");
	assert.equal(result.createdTag, false);
	const writes = calls.filter((call) => call.method !== "GET");
	assert.equal(writes.length, 1);
	assert.equal(writes[0].method, "PATCH");
	assert.equal(writes[0].path, "/releases/7");
	assert.equal(writes[0].body.draft, false);
	assert.equal(writes[0].body.body, "Notes.\n");
	assert.equal(writes[0].body.make_latest, "true");
});

test("an annotated tag on the same commit counts as this release", async () => {
	const { fn, calls } = fakeGitHub({
		refs: { "v2026.10.22.1": { type: "tag", sha: "1111111111111111111111111111111111111111" } },
		tagObjects: { "1111111111111111111111111111111111111111": { type: "commit", sha: SHA } },
	});
	const result = await publishRelease(release(), options(fn));
	assert.equal(result.outcome, "published");
	assert.ok(calls.some((call) => call.path === "/git/tags/1111111111111111111111111111111111111111"));
	assert.ok(!calls.some((call) => call.path === "/git/refs"));
});

test("a published release is never edited", async () => {
	const { fn, calls } = fakeGitHub({
		refs: { "v2026.10.22.1": { type: "commit", sha: SHA } },
		releases: [{ id: 9, tag_name: "v2026.10.22.1", draft: false, html_url: "https://example/r/9" }],
	});
	const result = await publishRelease(release(), options(fn));
	assert.deepEqual(result, {
		outcome: "already-published",
		tag: "v2026.10.22.1",
		createdTag: false,
		url: "https://example/r/9",
	});
	assert.deepEqual(
		calls.filter((call) => call.method !== "GET"),
		[],
	);
});

test("a tag on another commit means VERSION was not bumped: nothing is written", async () => {
	const { fn, calls } = fakeGitHub({ refs: { "v2026.10.22.1": { type: "commit", sha: OTHER_SHA } } });
	const result = await publishRelease(release(), options(fn));
	assert.deepEqual(result, { outcome: "not-bumped", tag: "v2026.10.22.1", taggedSha: OTHER_SHA });
	assert.deepEqual(
		calls.map((call) => call.method),
		["GET"],
	);
});

test("an older release on a later page is found, not duplicated", async () => {
	const many = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, tag_name: `v2025.01.01.${index}` }));
	const { fn, calls } = fakeGitHub({
		refs: { "v2026.10.22.1": { type: "commit", sha: SHA } },
		releases: [...many, { id: 700, tag_name: "v2026.10.22.1", draft: true }],
	});
	const result = await publishRelease(release(), options(fn));
	assert.equal(result.outcome, "published-draft");
	assert.ok(calls.some((call) => call.page === "2"));
	assert.ok(calls.some((call) => call.method === "PATCH" && call.path === "/releases/700"));
});

test("a release list past the page cap fails closed without creating a release", async () => {
	const many = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, tag_name: `v2025.01.01.${index}` }));
	const fn = async (url, init = {}) => {
		const path = new URL(String(url)).pathname;
		if (path.endsWith("/git/ref/tags/v2026.10.22.1"))
			return new Response(JSON.stringify({ object: { type: "commit", sha: SHA } }));
		if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify(many));
		return new Response("{}", { status: 201 });
	};
	await assert.rejects(publishRelease(release(), options(fn)), /not creating a possible duplicate/);
});

test("a failed API call throws without leaking the token, and a bad VERSION writes nothing", async () => {
	const denied = async () => new Response("nope", { status: 403 });
	await assert.rejects(
		publishRelease(release(), { fetch: denied, token: "secret-tok", repo: "a/b" }),
		(error) => /failed with 403/.test(error.message) && !error.message.includes("secret-tok"),
	);
	const { fn, calls } = fakeGitHub();
	await assert.rejects(publishRelease(release({ version: "next" }), options(fn)), /not a calendar version/);
	assert.equal(calls.length, 0);
});
