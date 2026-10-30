import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const lib = await bundleModules("kite-storage-store-form-", [
	[
		"presetFor, presetEndpoint, normalizeR2AccountId, isValidR2AccountId, parseR2Endpoint, r2TokenPage, R2_TOKEN_PAGE",
		"src/lib/storage/s3-presets-utils.ts",
	],
	[
		"emptyStoreForm, storeFormOf, withProvider, formEndpoint, storeFormErrors, storeFormBody, corsFailed, testSummary, usesPresetEndpoint",
		"src/app/(admin)/storage/form-utils.ts",
	],
	["bucketFailureStep, accessFix, describeFailure", "src/lib/storage/validate-utils.ts"],
	["credentialProblem", "src/lib/storage/credential-utils.ts"],
	["parseStoreInput", "src/lib/storage/store-input-utils.ts"],
]);

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const R2_KEY = "fedcba9876543210fedcba9876543210";
const R2_SECRET = "a".repeat(64);

const form = (overrides = {}) => ({ ...lib.emptyStoreForm("aws"), ...overrides });

test("each preset builds its endpoint from the region, and R2 from the account id and jurisdiction", () => {
	assert.equal(lib.presetEndpoint("aws", { region: "eu-central-1" }), "https://s3.eu-central-1.amazonaws.com");
	assert.equal(lib.presetEndpoint("b2", { region: "us-west-004" }), "https://s3.us-west-004.backblazeb2.com");
	assert.equal(lib.presetEndpoint("wasabi", { region: "eu-central-2" }), "https://s3.eu-central-2.wasabisys.com");
	assert.equal(lib.presetEndpoint("hetzner", { region: "fsn1" }), "https://fsn1.your-objectstorage.com");
	assert.equal(lib.presetEndpoint("aws", { region: "" }), null, "no region, no endpoint");
	assert.equal(lib.presetEndpoint("minio", { region: "us-east-1" }), null, "MinIO has no endpoint of its own");
	assert.equal(
		lib.presetEndpoint("r2", { region: "auto", accountId: ACCOUNT }),
		`https://${ACCOUNT}.r2.cloudflarestorage.com`,
	);
	assert.equal(
		lib.presetEndpoint("r2", { region: "auto", accountId: ACCOUNT, jurisdiction: "eu" }),
		`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
	);
	assert.equal(lib.presetEndpoint("r2", { region: "auto", accountId: "not-an-id" }), null);
	for (const provider of ["aws", "r2", "b2", "wasabi", "hetzner", "minio", "other"])
		assert.ok(lib.presetFor(provider).credentialsHelp, `${provider} says which permission the key needs`);
	for (const provider of ["aws", "b2", "wasabi", "hetzner"]) assert.ok(lib.presetFor(provider).regions.length > 1);
});

test("an R2 account id is taken from the id itself or from a pasted S3 API URL", () => {
	assert.equal(lib.normalizeR2AccountId(` ${ACCOUNT.toUpperCase()} `), ACCOUNT);
	assert.equal(lib.normalizeR2AccountId(`https://${ACCOUNT}.r2.cloudflarestorage.com/kite-raw`), ACCOUNT);
	assert.equal(lib.normalizeR2AccountId(`${ACCOUNT}.eu.r2.cloudflarestorage.com`), ACCOUNT);
	assert.equal(lib.isValidR2AccountId(ACCOUNT), true);
	assert.equal(lib.isValidR2AccountId("abc"), false);
	assert.deepEqual(lib.parseR2Endpoint(`${ACCOUNT}.eu.r2.cloudflarestorage.com`), {
		accountId: ACCOUNT,
		jurisdiction: "eu",
	});
	assert.equal(lib.parseR2Endpoint("s3.amazonaws.com"), null);
	assert.equal(lib.r2TokenPage(ACCOUNT), `https://dash.cloudflare.com/${ACCOUNT}/r2/api-tokens`);
	assert.equal(lib.r2TokenPage(""), lib.R2_TOKEN_PAGE);
});

test("the R2 preset sends the built endpoint, region auto and path addressing", () => {
	const r2 = { ...lib.emptyStoreForm("r2", true), accountId: ACCOUNT, accessKeyId: R2_KEY, secretAccessKey: R2_SECRET };
	assert.equal(r2.bucket, "kite-raw");
	assert.deepEqual(lib.storeFormErrors(r2), {});
	const body = lib.storeFormBody(r2, false);
	assert.equal(body.endpoint, `https://${ACCOUNT}.r2.cloudflarestorage.com`);
	assert.equal(body.region, "auto");
	assert.equal(body.addressing, "path");
	assert.equal(body.sameAsBinding, true);
	assert.equal(body.storeId, undefined);
});

test("switching provider fills the preset and keeps what was typed", () => {
	const typed = form({ name: "Archive", bucket: "kite-archive", accessKeyId: "AKIA", region: "eu-west-1" });
	const minio = lib.withProvider(typed, "minio");
	assert.equal(minio.region, "", "an AWS region means nothing to MinIO");
	assert.equal(minio.addressing, "path");
	assert.equal(minio.bucket, "kite-archive");
	assert.equal(minio.accessKeyId, "AKIA");
	assert.equal(lib.usesPresetEndpoint(minio), false);
	const r2 = lib.withProvider(minio, "r2");
	assert.equal(r2.region, "auto");
	assert.equal(lib.usesPresetEndpoint(r2), true);
	const other = lib.withProvider({ ...minio, region: "us-east-1" }, "other");
	assert.equal(other.region, "us-east-1", "MinIO to Other keeps a typed region");
});

test("field errors name each missing or malformed field", () => {
	const errors = lib.storeFormErrors(form());
	assert.deepEqual(Object.keys(errors).sort(), ["accessKeyId", "bucket", "name", "region", "secretAccessKey"]);
	const r2 = lib.storeFormErrors({ ...lib.emptyStoreForm("r2"), accountId: "nope" });
	assert.match(r2.accountId, /32 letters/);
	const minio = lib.storeFormErrors({ ...lib.emptyStoreForm("minio"), endpoint: "https://s3.example.com/bucket" });
	assert.match(minio.endpoint, /host only/);
	assert.match(minio.region, /region/);
	const fine = form({ name: "A", region: "eu-west-1", bucket: "kite.files", accessKeyId: "k", secretAccessKey: "s" });
	assert.match(lib.storeFormErrors(fine).bucket, /path-style/, "dots need path-style on AWS");
	assert.deepEqual(lib.storeFormErrors({ ...fine, bucket: "kite-files" }), {});
	assert.match(
		lib.storeFormErrors({ ...fine, bucket: "kite-files", secretAccessKey: "a b" }).secretAccessKey,
		/secret/,
	);
	assert.equal(
		lib.storeFormErrors({ ...fine, bucket: "kite-files", accessKeyId: "", secretAccessKey: "" }, { editing: true })
			.accessKeyId,
		undefined,
	);
});

test("a saved store opens on its preset, or on a custom endpoint the preset would not build", () => {
	const saved = {
		id: "sto_a",
		name: "A",
		provider: "aws",
		endpoint: "s3.eu-west-1.amazonaws.com",
		region: "eu-west-1",
		bucket: "kite-files",
		addressing: "virtual",
		sameAsBinding: false,
	};
	assert.equal(lib.storeFormOf(saved).customEndpoint, false);
	assert.equal(lib.storeFormOf({ ...saved, endpoint: "s3-fips.eu-west-1.amazonaws.com" }).customEndpoint, true);
	const r2 = lib.storeFormOf({
		...saved,
		provider: "r2",
		endpoint: `${ACCOUNT}.r2.cloudflarestorage.com`,
		region: "auto",
		addressing: "path",
	});
	assert.equal(r2.accountId, ACCOUNT);
	assert.equal(lib.formEndpoint(r2), `https://${ACCOUNT}.r2.cloudflarestorage.com`);
	const body = lib.storeFormBody(lib.storeFormOf(saved), true, "sto_a");
	assert.equal(body.storeId, "sto_a");
	assert.equal(body.accessKeyId, undefined, "a blank key pair keeps the saved one");
});

test("the test summary separates a working connection, a missing CORS rule and a failure", () => {
	const ok = (id) => ({ id, label: id, status: "ok" });
	const failed = (id) => ({ id, label: id, status: "failed" });
	assert.equal(lib.testSummary([ok("bucket"), ok("cors_preflight")]).tone, "ok");
	const cors = [ok("bucket"), failed("cors_preflight"), failed("cors_upload")];
	assert.equal(lib.testSummary(cors).tone, "warn");
	assert.equal(lib.corsFailed(cors), true);
	assert.equal(lib.testSummary([failed("credentials"), failed("cors_upload")]).tone, "error");
	assert.equal(lib.corsFailed([ok("cors_upload")]), false);
});

test("a failed bucket check is placed on the endpoint, the credentials or the bucket", () => {
	assert.equal(lib.bucketFailureStep({ network: true }), "endpoint");
	assert.equal(lib.bucketFailureStep({ status: 403, code: "SignatureDoesNotMatch" }), "credentials");
	assert.equal(lib.bucketFailureStep({ status: 403, code: "InvalidAccessKeyId" }), "credentials");
	assert.equal(lib.bucketFailureStep({ status: 401, code: "HTTP401" }), "credentials");
	assert.equal(lib.bucketFailureStep({ status: 404, code: "NoSuchBucket" }), "bucket");
	assert.equal(lib.bucketFailureStep({ status: 403, code: "AccessDenied" }), "bucket");
});

test("fix hints name the provider's permission and the bucket", () => {
	const r2 = { provider: "r2", bucket: "kite-raw" };
	assert.equal(
		lib.accessFix("write", r2),
		"Access denied: give the R2 API token Object Read & Write on kite-raw (R2 → Manage API tokens).",
	);
	assert.match(lib.accessFix("write", { provider: "aws", bucket: "b" }), /s3:PutObject on b/);
	assert.match(lib.accessFix("list", { provider: "minio", bucket: "b" }), /s3:ListBucket on b.*readwrite/);
	assert.match(lib.accessFix("write", { provider: "b2", bucket: "b" }), /application key/);
	assert.match(lib.describeFailure("write", { status: 403, code: "AccessDenied" }, r2).fix, /Object Read & Write/);
	assert.match(lib.describeFailure("credentials", { code: "SignatureDoesNotMatch" }, r2).fix, /only once/);
	assert.match(lib.describeFailure("bucket", { code: "NoSuchBucket" }, r2).fix, /kite-raw/);
	assert.match(lib.describeFailure("write", { status: 403 }).fix, /s3:PutObject/, "without context, the generic hint");
});

test("a key problem names the field, why and what to do", () => {
	const problem = (field, value, provider = "aws", options) => lib.credentialProblem(field, value, provider, options);
	assert.equal(problem("accessKeyId", ""), "Enter the access key ID");
	assert.equal(
		problem("secretAccessKey", "abc def"),
		"The secret access key contains a space or line break; paste only the key itself",
	);
	assert.match(problem("accessKeyId", "AKIA\nEXAMPLE"), /^The access key ID contains a space or line break/);
	assert.equal(
		problem("secretAccessKey", "a".repeat(300), "r2"),
		"The secret access key is too long (300 characters); R2 secret access keys are 64 characters. Paste only the key itself",
	);
	assert.equal(
		problem("secretAccessKey", "a".repeat(300)),
		"The secret access key is too long (300 characters). Paste only the key itself",
	);
	assert.equal(problem("secretAccessKey", "a".repeat(80), "aws"), null, "other providers' keys have no fixed shape");
	assert.equal(problem("secretAccessKey", "a".repeat(80), "r2"), null, "the server leaves R2's shape to the store");
	assert.match(problem("secretAccessKey", "a".repeat(40), "r2", { shape: true }), /are 64 characters; this one has 40/);
	assert.match(problem("accessKeyId", "z".repeat(32), "r2", { shape: true }), /digits and the letters a to f/);
	assert.equal(problem("accessKeyId", R2_KEY, "r2", { shape: true }), null);
	assert.equal(problem("secretAccessKey", R2_SECRET.toUpperCase(), "r2", { shape: true }), null);
});

test("the form shows R2's key shape under the field, and the server names the field it refuses", () => {
	const r2 = { ...lib.emptyStoreForm("r2", true), accountId: ACCOUNT, accessKeyId: R2_KEY, secretAccessKey: "short" };
	assert.deepEqual(Object.keys(lib.storeFormErrors(r2)), ["secretAccessKey"]);
	assert.match(lib.storeFormErrors(r2).secretAccessKey, /R2 secret access keys are 64 characters/);
	const body = {
		name: "A",
		provider: "minio",
		endpoint: "https://minio.example.com",
		region: "us-east-1",
		bucket: "kite-files",
		accessKeyId: "key",
		secretAccessKey: "two words",
	};
	const refused = lib.parseStoreInput(body);
	assert.equal(refused.ok, false);
	assert.equal(refused.field, "secretAccessKey");
	assert.match(refused.error, /secret access key contains a space/);
	const long = lib.parseStoreInput({ ...body, secretAccessKey: "x", accessKeyId: "k".repeat(257) });
	assert.equal(long.field, "accessKeyId");
	assert.match(long.error, /too long \(257 characters\)/);
	assert.equal(lib.parseStoreInput({ ...body, secretAccessKey: "secret" }).ok, true);
});
