import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const presets = await bundleModules("kite-storage-presets-", [
	[
		"S3_PRESETS, presetFor, isS3Provider, b2RegionFromEndpoint, regionFromEndpoint, parseEndpoint, isValidBucketName, isValidStoreRegion, supportsVirtualAddressing",
		"src/lib/storage/s3-presets-utils.ts",
	],
]);

test("presets build each provider's endpoint and addressing", () => {
	const endpoint = (provider, input) => presets.presetFor(provider).endpoint(input);
	assert.equal(endpoint("aws", { region: "eu-central-1" }), "s3.eu-central-1.amazonaws.com");
	assert.equal(endpoint("b2", { region: "us-west-004" }), "s3.us-west-004.backblazeb2.com");
	assert.equal(endpoint("wasabi", { region: "eu-central-2" }), "s3.eu-central-2.wasabisys.com");
	assert.equal(endpoint("hetzner", { region: "fsn1" }), "fsn1.your-objectstorage.com");
	assert.equal(endpoint("r2", { region: "auto", accountId: "abc123" }), "abc123.r2.cloudflarestorage.com");
	assert.equal(endpoint("r2", { region: "auto" }), ".r2.cloudflarestorage.com");
	assert.equal(presets.presetFor("minio").endpoint, null);
	assert.equal(presets.presetFor("minio").addressing, "path");
	assert.equal(presets.presetFor("aws").addressing, "virtual");
	assert.equal(presets.presetFor("r2").region, "auto");
	assert.equal(presets.presetFor("nope"), null);
	assert.deepEqual(
		presets.S3_PRESETS.filter((preset) => preset.applyCors).map((preset) => preset.provider),
		["aws", "r2", "wasabi", "minio"],
	);
	assert.equal(presets.isS3Provider("b2"), true);
	assert.equal(presets.isS3Provider("gcs"), false);
	assert.equal(presets.isS3Provider(7), false);
});

test("regions are read from pasted endpoints", () => {
	assert.equal(presets.b2RegionFromEndpoint("s3.us-west-004.backblazeb2.com"), "us-west-004");
	assert.equal(presets.b2RegionFromEndpoint("s3.amazonaws.com"), null);
	assert.equal(presets.regionFromEndpoint("aws", "s3.eu-west-1.amazonaws.com"), "eu-west-1");
	assert.equal(presets.regionFromEndpoint("aws", "s3-eu-west-1.amazonaws.com"), "eu-west-1");
	assert.equal(presets.regionFromEndpoint("b2", "s3.eu-central-003.backblazeb2.com"), "eu-central-003");
	assert.equal(presets.regionFromEndpoint("wasabi", "s3.ap-northeast-1.wasabisys.com"), "ap-northeast-1");
	assert.equal(presets.regionFromEndpoint("hetzner", "nbg1.your-objectstorage.com"), "nbg1");
	assert.equal(presets.regionFromEndpoint("r2", "x.r2.cloudflarestorage.com"), "auto");
	assert.equal(presets.regionFromEndpoint("minio", "localhost:9000"), null);
});

test("endpoints are hosts with an optional port and scheme, nothing more", () => {
	assert.deepEqual(presets.parseEndpoint("S3.Example.com"), { endpoint: "s3.example.com", scheme: "https" });
	assert.deepEqual(presets.parseEndpoint("https://s3.example.com/"), { endpoint: "s3.example.com", scheme: "https" });
	assert.deepEqual(presets.parseEndpoint(" http://localhost:9000 "), { endpoint: "localhost:9000", scheme: "http" });
	for (const bad of [
		"",
		"   ",
		5,
		null,
		"ftp://host",
		"https://user:pw@host",
		"https://host/bucket",
		"https://host?x=1",
		"https://",
	])
		assert.ok("error" in presets.parseEndpoint(bad), `refuses ${String(bad)}`);
});

test("bucket names and regions are checked before any request", () => {
	assert.equal(presets.isValidBucketName("kite-files"), true);
	assert.equal(presets.isValidBucketName("Old_Bucket.1"), true);
	assert.equal(presets.isValidBucketName("a"), false);
	assert.equal(presets.isValidBucketName("bad/bucket"), false);
	assert.equal(presets.isValidBucketName(undefined), false);
	assert.equal(presets.isValidStoreRegion("us-east-1"), true);
	assert.equal(presets.isValidStoreRegion("auto"), true);
	assert.equal(presets.isValidStoreRegion("US East"), false);
	assert.equal(presets.isValidStoreRegion(1), false);
	assert.equal(presets.supportsVirtualAddressing("kite-files"), true);
	assert.equal(presets.supportsVirtualAddressing("Kite.Files"), false);
});
