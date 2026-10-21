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

const pure = await bundleModules("kite-storage-config-pure-", [
	[
		"storageEndpointPolicy, storedEndpoint, parseStoredEndpoint, endpointHostname, isLoopbackHostname, endpointProblem, isAllowedLocalEndpoint",
		"src/lib/storage/endpoint-utils.ts",
	],
	["parseStoreInput, needsRevalidation, corsOrigins", "src/lib/storage/store-input-utils.ts"],
	[
		"STEP_LABELS, REQUIRED_STEPS, storePolicy, describeFailure, preflightProblem, uploadResponseProblem, corsFix, reportFrom, reportSummary",
		"src/lib/storage/validate-utils.ts",
	],
	[
		"MAX_BATCH_OBJECTS, MAX_BATCH_BYTES, COPY_PART_BYTES, isStorageMigrateMessage, sourcesFor, initialCursor, parseCursor, nextSource, advance, nextPhase, takeBatch, copyParts, isLeased, isStalled, isActiveMigration, purgeConfirmationMatches",
		"src/lib/storage/migration-utils.ts",
	],
]);

test("the dev flags widen the endpoint guard only where they may", () => {
	const policy = (env, nodeEnv = "development") => pure.storageEndpointPolicy(env, nodeEnv);
	assert.deepEqual(policy({}), { allowInsecure: false, allowPrivate: false });
	assert.deepEqual(policy({ STORAGE_ALLOW_INSECURE_ENDPOINT: "1" }), { allowInsecure: true, allowPrivate: false });
	assert.deepEqual(policy({ STORAGE_ALLOW_INSECURE_ENDPOINT: "true" }, "production"), {
		allowInsecure: false,
		allowPrivate: false,
	});
	assert.equal(policy({ STORAGE_ALLOW_PRIVATE_ENDPOINTS: "1" }).allowPrivate, false, "Workers never reach LAN hosts");
	assert.equal(policy({ STORAGE_ALLOW_PRIVATE_ENDPOINTS: "1", KITE_RUNTIME: "node" }, "production").allowPrivate, true);

	const strict = { allowInsecure: false, allowPrivate: false };
	const insecure = { allowInsecure: true, allowPrivate: false };
	const lan = { allowInsecure: false, allowPrivate: true };
	const problem = (endpoint, scheme, current) => pure.endpointProblem({ endpoint, scheme }, current);
	assert.equal(problem("s3.example.com", "https", strict), null);
	assert.match(problem("s3.example.com", "http", strict), /https/);
	assert.equal(problem("s3.example.com", "http", insecure), null);
	assert.match(problem("localhost:9000", "https", strict), /Private/);
	assert.equal(problem("localhost:9000", "http", insecure), null);
	assert.equal(problem("[::1]:9000", "http", insecure), null);
	assert.match(problem("10.0.0.5:9000", "http", insecure), /Private/, "the insecure flag allows loopback only");
	assert.equal(problem("10.0.0.5:9000", "http", lan), null);
	assert.match(problem("s3.example.com", "http", lan), /https/, "the private flag does not allow public http");
	assert.match(problem("", "https", strict), /Enter/);
	assert.equal(pure.isAllowedLocalEndpoint({ endpoint: "127.0.0.1:9000" }, insecure), true);
	assert.equal(pure.isAllowedLocalEndpoint({ endpoint: "s3.example.com" }, insecure), false);
	assert.equal(pure.isAllowedLocalEndpoint({ endpoint: "minio:9000" }, lan), true);
	assert.equal(pure.isLoopbackHostname("127.1.2.3"), true);
	assert.equal(pure.isLoopbackHostname("localhost.example.com"), false);
	assert.equal(pure.endpointHostname("[::1]:9000"), "::1");
	assert.equal(pure.endpointHostname("::1"), "::1");
	assert.equal(pure.endpointHostname("Minio:9000"), "minio");
	assert.equal(pure.storedEndpoint({ endpoint: "localhost:9000", scheme: "http" }), "http://localhost:9000");
	assert.equal(pure.storedEndpoint({ endpoint: "s3.example.com", scheme: "https" }), "s3.example.com");
	assert.deepEqual(pure.parseStoredEndpoint("http://localhost:9000"), { endpoint: "localhost:9000", scheme: "http" });
	assert.deepEqual(pure.parseStoredEndpoint("s3.example.com"), { endpoint: "s3.example.com", scheme: "https" });
});

const storeForm = {
	name: "Archive",
	provider: "aws",
	endpoint: "s3.eu-central-1.amazonaws.com",
	region: "",
	bucket: "kite-archive",
	accessKeyId: "AKIAINVENTED00001",
	secretAccessKey: "invented-secret-value",
};

test("the store form is parsed into a location, with preset and endpoint defaults", () => {
	const parsed = pure.parseStoreInput(storeForm);
	assert.equal(parsed.ok, true);
	assert.deepEqual(parsed.value.location, {
		endpoint: "s3.eu-central-1.amazonaws.com",
		scheme: "https",
		region: "eu-central-1",
		bucket: "kite-archive",
		addressing: "virtual",
	});
	assert.equal(
		pure.parseStoreInput({ ...storeForm, provider: "r2", endpoint: "abc.r2.cloudflarestorage.com" }).value.location
			.region,
		"auto",
	);
	const refusals = [
		[null, /JSON/],
		[{ ...storeForm, name: "" }, /name/],
		[{ ...storeForm, name: "x".repeat(81) }, /name/],
		[{ ...storeForm, provider: "gcs" }, /provider/],
		[{ ...storeForm, endpoint: "ftp://s3.example.com" }, /https/],
		[{ ...storeForm, bucket: "a" }, /bucket/],
		[{ ...storeForm, provider: "other", endpoint: "s3.example.com" }, /region/],
		[{ ...storeForm, addressing: "sideways" }, /Addressing/],
		[{ ...storeForm, bucket: "Kite_Archive" }, /path-style/],
		[{ ...storeForm, sameAsBinding: true }, /R2/],
		[{ ...storeForm, secretAccessKey: "" }, /access key/],
		[{ ...storeForm, accessKeyId: "AKIA WITH SPACE" }, /key pair/],
	];
	for (const [input, error] of refusals) {
		const result = pure.parseStoreInput(input);
		assert.equal(result.ok, false, JSON.stringify(input));
		assert.match(result.error, error);
	}
});

test("an edit keeps saved fields and decides whether the checks must run again", () => {
	const existing = {
		name: "Archive",
		provider: "minio",
		location: { endpoint: "localhost:9000", scheme: "http", region: "us-east-1", bucket: "kite-a", addressing: "path" },
		sameAsBinding: false,
	};
	const rename = pure.parseStoreInput({ name: "Renamed" }, existing);
	assert.equal(rename.ok, true);
	assert.equal(rename.value.credentials, null);
	assert.deepEqual(rename.value.location, existing.location);
	assert.equal(pure.needsRevalidation(existing, rename.value), false);
	const bucket = pure.parseStoreInput({ bucket: "kite-b" }, existing);
	assert.equal(pure.needsRevalidation(existing, bucket.value), true);
	const keys = pure.parseStoreInput({ accessKeyId: "AKIAINVENTED", secretAccessKey: "secret-value" }, existing);
	assert.equal(pure.needsRevalidation(existing, keys.value), true);
	assert.equal(pure.parseStoreInput({ accessKeyId: "AKIAINVENTED" }, existing).ok, false);
	assert.deepEqual(
		pure.corsOrigins("http://localhost:3200/", "https://mail.example.com/path", null, "nope", "ftp://x"),
		["http://localhost:3200", "https://mail.example.com"],
	);
	assert.deepEqual(pure.corsOrigins("https://a.example", "https://a.example"), ["https://a.example"]);
});

test("validation failures are explained with the fix, by error code", () => {
	const fix = (step, failure) => pure.describeFailure(step, failure);
	assert.match(fix("bucket", { network: true }).detail, /reach/);
	assert.match(fix("bucket", { code: "SignatureDoesNotMatch" }).fix, /secret/);
	assert.match(fix("bucket", { code: "InvalidAccessKeyId" }).fix, /access key ID/);
	assert.match(fix("presign", { code: "AccessDenied", message: "Request has expired" }).fix, /clock/);
	assert.match(fix("bucket", { status: 404 }).detail, /does not exist/);
	assert.match(fix("bucket", { code: "PermanentRedirect" }).fix, /region/);
	assert.match(fix("write", { status: 403 }).fix, /s3:PutObject/);
	assert.match(fix("lifecycle", { status: 403 }).fix, /policy/);
	assert.match(fix("write", { message: "Slow down" }).detail, /Slow down/);
	assert.equal(fix("endpoint", {}).fix, undefined);
	const policy = pure.storePolicy("kite-archive");
	assert.ok(JSON.stringify(policy).includes("arn:aws:s3:::kite-archive"));
	assert.ok(JSON.stringify(policy).includes("s3:AbortMultipartUpload"));

	const origin = "http://localhost:3200";
	const headers = (values) => new Headers(values);
	const good = {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET, PUT",
		"access-control-allow-headers": "content-type",
	};
	assert.equal(pure.preflightProblem(headers(good), 200, origin), null);
	assert.match(pure.preflightProblem(headers({}), 403, origin), /did not allow/);
	assert.match(
		pure.preflightProblem(headers({ ...good, "access-control-allow-origin": "https://x.example" }), 200, origin),
		/not/,
	);
	assert.match(pure.preflightProblem(headers({ ...good, "access-control-allow-methods": "GET" }), 200, origin), /PUT/);
	assert.match(
		pure.preflightProblem(headers({ ...good, "access-control-allow-headers": "x-a" }), 200, origin),
		/Content-Type/,
	);
	assert.equal(pure.preflightProblem(headers({ ...good, "access-control-allow-headers": "*" }), 200, origin), null);
	assert.equal(
		pure.uploadResponseProblem(
			headers({ "access-control-allow-origin": "*", "access-control-expose-headers": "ETag" }),
			origin,
		),
		null,
	);
	assert.match(pure.uploadResponseProblem(headers({}), origin), /does not allow/);
	assert.match(pure.uploadResponseProblem(headers({ "access-control-allow-origin": origin }), origin), /ETag/);
	assert.match(pure.corsFix("aws", true), /Apply CORS/);
	assert.match(pure.corsFix("b2", false), /B2/);
	assert.match(pure.corsFix("other", false), /console/);

	const passed = pure.REQUIRED_STEPS.map((id) => ({ id, label: pure.STEP_LABELS[id], status: "ok" }));
	const report = pure.reportFrom(passed);
	assert.deepEqual([report.ok, report.cors], [true, false]);
	assert.equal(pure.reportSummary(report), null);
	const broken = pure.reportFrom([
		...passed.slice(1),
		{ id: "endpoint", label: "Endpoint", status: "failed", detail: "Nope" },
	]);
	assert.equal(broken.ok, false);
	assert.equal(pure.reportSummary(broken), "Endpoint: Nope");
	const cors = pure.reportFrom([
		...passed,
		{ id: "cors_preflight", status: "ok" },
		{ id: "cors_upload", status: "ok" },
	]);
	assert.equal(cors.cors, true);
});

test("the migration planner walks each source, then verifies, with bounded batches", () => {
	assert.deepEqual(pure.sourcesFor("mail"), ["messages", "attachments"]);
	assert.deepEqual(pure.sourcesFor("drive"), ["drive"]);
	assert.deepEqual(pure.sourcesFor("backups"), ["backups"]);
	let cursor = pure.initialCursor("mail");
	assert.deepEqual(cursor, { phase: "copy", sources: { messages: null, attachments: null } });
	assert.equal(pure.nextSource(cursor, "mail"), "messages");
	cursor = pure.advance(cursor, "messages", "m50", false);
	assert.equal(cursor.sources.messages, "m50");
	cursor = pure.advance(cursor, "messages", "m60", true);
	assert.equal(pure.nextSource(cursor, "mail"), "attachments");
	cursor = pure.advance(cursor, "attachments", null, true);
	assert.equal(pure.nextSource(cursor, "mail"), null);
	cursor = pure.nextPhase(cursor, "mail");
	assert.equal(cursor.phase, "verify");
	assert.equal(cursor.sources.messages, null);
	assert.equal(pure.nextPhase(cursor, "mail").phase, "done");
	assert.equal(pure.nextPhase(pure.initialCursor("drive", "purge"), "drive").phase, "purged");
	for (const phase of ["done", "purged"]) {
		const terminal = { ...pure.initialCursor("drive", phase), lastBatchAt: 123 };
		assert.equal(pure.nextPhase(terminal, "drive"), terminal);
	}
	assert.deepEqual(pure.parseCursor(JSON.stringify(cursor), "mail"), cursor);
	assert.deepEqual(pure.parseCursor("{broken", "backups"), pure.initialCursor("backups"));
	assert.deepEqual(pure.parseCursor(null, "drive"), pure.initialCursor("drive"));
	assert.deepEqual(pure.parseCursor('{"phase":1}', "drive"), pure.initialCursor("drive"));

	const objects = Array.from({ length: 60 }, (_, index) => ({ id: index, size: 1 }));
	assert.equal(pure.takeBatch(objects).length, pure.MAX_BATCH_OBJECTS);
	const big = [{ size: pure.MAX_BATCH_BYTES }, { size: 1 }];
	assert.equal(pure.takeBatch(big).length, 1, "a full batch stops before the byte budget");
	assert.equal(pure.takeBatch([{ size: pure.MAX_BATCH_BYTES * 4 }]).length, 1, "one huge object still moves");
	assert.equal(pure.takeBatch([{ size: null }, {}]).length, 2);
	assert.deepEqual(pure.copyParts(10, 4), [
		{ partNumber: 1, offset: 0, length: 4 },
		{ partNumber: 2, offset: 4, length: 4 },
		{ partNumber: 3, offset: 8, length: 2 },
	]);
	assert.equal(pure.copyParts(pure.COPY_PART_BYTES * 2 + 1).length, 3);
	assert.deepEqual(pure.copyParts(0), []);

	const now = 1_000_000_000;
	assert.equal(pure.isLeased({ leaseUntil: now + 1 }, now), true);
	assert.equal(pure.isLeased({}, now), false);
	assert.equal(pure.isStalled({ leaseUntil: now + 1 }, now, 0), false);
	assert.equal(pure.isStalled({ lastBatchAt: now - 60_000 }, now, 0), false);
	assert.equal(pure.isStalled({ lastBatchAt: now - 6 * 60_000 }, now, null), true);
	assert.equal(pure.isStalled({}, now, now - 1000), false);
	assert.equal(pure.isStalled({}, now, null), true);
	assert.equal(pure.isActiveMigration("verifying"), true);
	assert.equal(pure.isActiveMigration("completed"), false);
	assert.equal(pure.isStorageMigrateMessage({ kind: "storage.migrate", jobId: "smg_1" }), true);
	for (const value of [null, "storage.migrate", { kind: "storage.migrate" }, { kind: "backup.run", jobId: "x" }])
		assert.equal(pure.isStorageMigrateMessage(value), false);
	assert.equal(pure.purgeConfirmationMatches(" cloudflare r2 ", "Cloudflare R2"), true);
	assert.equal(pure.purgeConfirmationMatches("R2", "Cloudflare R2"), false);
	assert.equal(pure.purgeConfirmationMatches(undefined, "Cloudflare R2"), false);
});
