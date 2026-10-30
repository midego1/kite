import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const lib = await bundleModules("kite-storage-r2-utils-", [
	[
		"r2BucketNameProblem, suggestedBucketName, r2BucketResource, r2Endpoint, r2CorsBody, bucketTokenBody, permissionForStep, isPermissionRefusal, isBucketExists, permissionMessage, parseR2SetupInput, loopbackTestOrigin, isR2Jurisdiction, isR2LocationHint, R2_PERMISSIONS, DEFAULT_BINDING_BUCKET",
		"src/lib/storage/cloudflare-r2-utils.ts",
	],
]);

const ACCOUNT = "0123456789abcdef0123456789abcdef";

test("R2 bucket names follow Cloudflare's rules, with a suggestion per kind of data", () => {
	assert.equal(lib.r2BucketNameProblem("kite-drive"), null);
	assert.equal(lib.r2BucketNameProblem("abc"), null);
	assert.match(lib.r2BucketNameProblem(""), /Enter/);
	assert.match(lib.r2BucketNameProblem("ab"), /3 to 63/);
	assert.match(lib.r2BucketNameProblem("a".repeat(64)), /3 to 63/);
	assert.match(lib.r2BucketNameProblem("Kite-Drive"), /lowercase/);
	assert.match(lib.r2BucketNameProblem("kite_drive"), /hyphens/);
	assert.match(lib.r2BucketNameProblem("kite.drive"), /hyphens/);
	assert.match(lib.r2BucketNameProblem("-kite"), /Start and end/);
	assert.equal(lib.suggestedBucketName("drive"), "kite-drive");
	assert.equal(lib.suggestedBucketName("backups"), "kite-backups");
	assert.equal(lib.DEFAULT_BINDING_BUCKET, "kite-raw");
});

test("the token, endpoint and CORS requests follow Cloudflare's documented shapes", () => {
	assert.equal(
		lib.r2BucketResource(ACCOUNT, "", "kite-raw"),
		`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_kite-raw`,
	);
	assert.equal(lib.r2BucketResource(ACCOUNT, "eu", "kite-raw"), `com.cloudflare.edge.r2.bucket.${ACCOUNT}_eu_kite-raw`);
	assert.equal(lib.r2Endpoint(ACCOUNT, ""), `https://${ACCOUNT}.r2.cloudflarestorage.com`);
	assert.equal(lib.r2Endpoint(ACCOUNT, "fedramp"), `https://${ACCOUNT}.fedramp.r2.cloudflarestorage.com`);
	assert.deepEqual(lib.bucketTokenBody("Kite", "group", "resource"), {
		name: "Kite",
		policies: [{ effect: "allow", resources: { resource: "*" }, permission_groups: [{ id: "group" }] }],
	});
	const [rule] = lib.r2CorsBody(["https://kite.example.com"]).rules;
	assert.deepEqual(rule.allowed, {
		origins: ["https://kite.example.com"],
		methods: ["PUT", "GET", "HEAD"],
		headers: ["content-type"],
	});
	assert.deepEqual(rule.exposeHeaders, ["ETag"]);
	const other = { id: "photos-site", allowed: { origins: ["https://photos.example.com"], methods: ["GET"] } };
	const stale = { id: "kite-direct-uploads", allowed: { origins: ["https://old.example.com"], methods: ["PUT"] } };
	const merged = lib.r2CorsBody(["https://kite.example.com"], [other, stale]).rules;
	assert.deepEqual(merged[0], other, "another site's rule is kept as it was");
	assert.equal(merged.length, 2, "Kite's earlier rule is replaced, not repeated");
	assert.deepEqual(merged[1].allowed.origins, ["https://kite.example.com"]);
});

test("a refusal names the permission CF_TOKEN needs for that step", () => {
	assert.equal(lib.permissionForStep("account"), lib.R2_PERMISSIONS.account);
	assert.equal(lib.permissionForStep("bucket"), "Workers R2 Storage: Edit");
	assert.equal(lib.permissionForStep("cors"), "Workers R2 Storage: Edit");
	assert.equal(lib.permissionForStep("token"), "Account API Tokens: Edit");
	assert.equal(lib.permissionForStep("keys"), null);
	assert.match(lib.permissionMessage("token"), /"Account API Tokens: Edit".*by hand/);
	assert.match(lib.permissionMessage("checks"), /Try again/);
	assert.equal(lib.isPermissionRefusal({ status: 403, codes: [] }), true);
	assert.equal(lib.isPermissionRefusal({ status: 400, codes: [10000] }), true);
	assert.equal(lib.isPermissionRefusal({ status: 400, codes: [7003] }), false);
	assert.equal(lib.isBucketExists({ status: 409, codes: [] }), true);
	assert.equal(lib.isBucketExists({ status: 400, codes: [10004] }), true);
	assert.equal(lib.isBucketExists({ status: 400, codes: [] }), false);
});

test("the one-click request is read strictly", () => {
	const parse = (body, requireBucket = true) => lib.parseR2SetupInput(body, { requireBucket });
	assert.deepEqual(parse({ bucket: " kite-drive ", create: true, locationHint: "weur", jurisdiction: "eu" }), {
		ok: true,
		value: { bucket: "kite-drive", jurisdiction: "eu", create: { locationHint: "weur" } },
	});
	assert.deepEqual(parse({ bucket: "kite-drive", create: false, name: "Drive" }).value, {
		bucket: "kite-drive",
		jurisdiction: "",
		create: null,
		name: "Drive",
	});
	assert.deepEqual(parse({}, false), { ok: true, value: { bucket: "", jurisdiction: "", create: null } });
	assert.equal(parse(null).field, "bucket");
	assert.equal(parse({ bucket: "Bad_Name" }).field, "bucket");
	assert.equal(parse({ bucket: "kite-x", jurisdiction: "mars" }).field, "jurisdiction");
	assert.equal(parse({ bucket: "kite-x", locationHint: "moon" }).field, "locationHint");
	assert.equal(parse({ bucket: "kite-x", name: "n".repeat(81) }).field, "name");
	assert.equal(lib.isR2Jurisdiction("fedramp"), true);
	assert.equal(lib.isR2LocationHint(""), true);
});

test("the Cloudflare stand-ins are loopback http only, and never in production", () => {
	assert.equal(lib.loopbackTestOrigin("http://127.0.0.1:3297/path", "development"), "http://127.0.0.1:3297");
	assert.equal(lib.loopbackTestOrigin("http://localhost:9000", "test"), "http://localhost:9000");
	assert.equal(lib.loopbackTestOrigin("http://127.0.0.1:3297", "production"), null);
	assert.equal(lib.loopbackTestOrigin("https://127.0.0.1:3297", "development"), null);
	assert.equal(lib.loopbackTestOrigin("http://api.cloudflare.com", "development"), null);
	assert.equal(lib.loopbackTestOrigin("not a url", "development"), null);
	assert.equal(lib.loopbackTestOrigin("", "development"), null);
	assert.equal(lib.loopbackTestOrigin(undefined, "development"), null);
});
