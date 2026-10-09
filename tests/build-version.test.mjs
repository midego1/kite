import assert from "node:assert/strict";
import test from "node:test";
import { getBuildVersion } from "../scripts/build-version.mjs";

test("build CalVer uses UTC and includes a short commit ID", () => {
	assert.deepEqual(getBuildVersion(new Date("2026-10-09T01:00:00+02:00"), { GITHUB_SHA: "abcdef0123456789" }), {
		version: "2026.10.08",
		commit: "abcdef0",
	});
});

test("Cloudflare build metadata takes precedence over GitHub", () => {
	assert.equal(
		getBuildVersion(new Date("2026-01-02Z"), { CF_BUILD_SHA: "1234567890", GITHUB_SHA: "abcdef012345" }).commit,
		"1234567",
	);
});

test("without valid CI metadata the local source revision is used", () => {
	assert.match(getBuildVersion(new Date("2026-01-02Z"), {}).commit, /^[a-f0-9]{7}$/);
	assert.match(getBuildVersion(new Date("2026-01-02Z"), { GITHUB_SHA: "not a commit" }).commit, /^[a-f0-9]{7}$/);
});
