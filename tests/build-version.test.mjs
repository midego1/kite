import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getBuildVersion } from "../scripts/build-version.mjs";

test("the build embeds the release from VERSION and a short commit ID", () => {
	assert.deepEqual(getBuildVersion({ GITHUB_SHA: "abcdef0123456789" }), {
		version: readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim(),
		commit: "abcdef0",
	});
});

test("Cloudflare build metadata takes precedence over GitHub", () => {
	assert.equal(getBuildVersion({ CF_BUILD_SHA: "1234567890", GITHUB_SHA: "abcdef012345" }).commit, "1234567");
});

test("without valid CI metadata the local source revision is used", () => {
	assert.match(getBuildVersion({}).commit, /^[a-f0-9]{7}$/);
	assert.match(getBuildVersion({ GITHUB_SHA: "not a commit" }).commit, /^[a-f0-9]{7}$/);
});
