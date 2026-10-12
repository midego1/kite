import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getBuildVersion } from "../scripts/build-version.mjs";

const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();

test("the build embeds the release from VERSION and a short commit ID", () => {
	const build = getBuildVersion({ GITHUB_SHA: "abcdef0123456789" });
	assert.equal(build.version, version);
	assert.equal(build.commit, "abcdef0");
});

test("Cloudflare build metadata takes precedence over GitHub", () => {
	assert.equal(getBuildVersion({ CF_BUILD_SHA: "1234567890", GITHUB_SHA: "abcdef012345" }).commit, "1234567");
});

test("without valid CI metadata the local source revision is used", () => {
	assert.match(getBuildVersion({}).commit, /^[a-f0-9]{7}$/);
	assert.match(getBuildVersion({ GITHUB_SHA: "not a commit" }).commit, /^[a-f0-9]{7}$/);
});

test("the build timestamp is ISO 8601 and can be pinned for reproducible builds", () => {
	assert.equal(getBuildVersion({ SOURCE_DATE_EPOCH: "1760000000" }).builtAt, "2025-10-09T08:53:20.000Z");
	assert.match(getBuildVersion({}).builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assert.match(getBuildVersion({ SOURCE_DATE_EPOCH: "not a number" }).builtAt, /^\d{4}-\d{2}-\d{2}T/);
});
