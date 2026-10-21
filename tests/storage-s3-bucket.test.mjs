import assert from "node:assert/strict";
import test, { after } from "node:test";
import { startFakeS3 } from "./support/fake-s3.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const { S3Bucket, MAX_BUFFERED_BYTES } = await bundleModules("kite-storage-s3-", [
	["S3Bucket, MAX_BUFFERED_BYTES", "src/lib/storage/s3-bucket.ts"],
]);
const utils = await bundleModules("kite-storage-s3-utils-", [
	[
		"metadataHeaders, readMetadata, rangeHeader, servedRange, toHttpMetadata, errorInBody, parseListObjects, corsRuleJson, bucketPath, objectPath",
		"src/lib/storage/s3-utils.ts",
	],
]);

const fake = await startFakeS3({ buckets: ["kite-test", "other-bucket"] });
after(() => fake.close());

const config = (overrides = {}) => ({
	endpoint: fake.endpoint,
	region: fake.region,
	bucket: "kite-test",
	addressing: "path",
	scheme: "http",
	accessKeyId: fake.accessKeyId,
	secretAccessKey: fake.secretAccessKey,
	...overrides,
});
const bucket = new S3Bucket(config());
/** Virtual-hosted names do not resolve locally, so those requests go to the fake in-process. */
const inProcess = (input, init) => fake.handle(new Request(input, init));

test("put, get, head and delete round-trip bytes and metadata", async () => {
	await bucket.put("inbound/one.eml", "Hello, world", {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { from: "Zoë <zoe@example.com>", to: "a@example.com", messageId: "msg_1" },
	});
	const object = await bucket.get("inbound/one.eml");
	assert.equal(await object.text(), "Hello, world");
	assert.equal(object.size, 12);
	assert.equal(object.httpMetadata.contentType, "message/rfc822");
	assert.deepEqual(object.customMetadata, { from: "Zoë <zoe@example.com>", to: "a@example.com", messageId: "msg_1" });
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	assert.equal(headers.get("content-type"), "message/rfc822");
	assert.match(object.httpEtag, /^"[0-9a-f]{32}"$/);
	const head = await bucket.head("inbound/one.eml");
	assert.equal(head.size, 12);
	assert.equal(head.etag, object.etag);
	assert.equal(await bucket.get("inbound/missing"), null);
	assert.equal(await bucket.head("inbound/missing"), null);
	await bucket.delete("inbound/one.eml");
	await bucket.delete(["inbound/one.eml", "never/existed"]);
	assert.equal(await bucket.head("inbound/one.eml"), null);
});

test("ranges are served with R2's offset, length and suffix forms", async () => {
	await bucket.put("drive/range", new TextEncoder().encode("0123456789"));
	const middle = await bucket.get("drive/range", { range: { offset: 2, length: 3 } });
	assert.equal(await middle.text(), "234");
	assert.equal(middle.size, 10);
	assert.deepEqual(middle.range, { offset: 2, length: 3 });
	assert.equal(await (await bucket.get("drive/range", { range: { offset: 7 } })).text(), "789");
	assert.equal(await (await bucket.get("drive/range", { range: { suffix: 2 } })).text(), "89");
	assert.equal(await (await bucket.get("drive/range", { range: new Headers({ range: "bytes=0-0" }) })).text(), "0");
});

test("streams of a known length are sent with Content-Length, unknown ones are buffered", async () => {
	const stream = () =>
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("abc"));
				controller.enqueue(new TextEncoder().encode("def"));
				controller.close();
			},
		});
	await bucket.put("backups/streamed", stream(), { contentLength: 6 });
	assert.equal(fake.object("kite-test", "backups/streamed").bytes.toString(), "abcdef");
	const put = fake.state.requests.findLast((request) => request.method === "PUT");
	assert.equal(put.headers["content-length"], "6");
	assert.equal(put.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
	await bucket.put("backups/buffered", stream());
	assert.equal(fake.object("kite-test", "backups/buffered").bytes.toString(), "abcdef");
	await bucket.put("backups/blob", new Blob(["xyz"]));
	await bucket.put("backups/empty", null);
	assert.equal(fake.object("kite-test", "backups/empty").bytes.length, 0);
	assert.equal(MAX_BUFFERED_BYTES, 32 * 1024 * 1024);
});

test("a body of unknown length over the buffer limit is refused", async () => {
	let sent = 0;
	const huge = new ReadableStream({
		pull(controller) {
			sent += 1024 * 1024;
			controller.enqueue(new Uint8Array(1024 * 1024));
			if (sent > MAX_BUFFERED_BYTES + 1024 * 1024) controller.close();
		},
	});
	await assert.rejects(bucket.put("backups/huge", huge), /too large to buffer/);
});

test("multipart uploads complete, and a wrong ETag is refused with InvalidPart", async () => {
	const upload = await bucket.createMultipartUpload("backups/database/b1.json", {
		httpMetadata: { contentType: "application/json" },
		customMetadata: { backupId: "b1" },
	});
	const first = await upload.uploadPart(1, "a".repeat(5));
	const second = await upload.uploadPart(2, new Blob(["bb"]));
	assert.deepEqual(
		(await bucket.listParts("backups/database/b1.json", upload.uploadId)).map((part) => part.partNumber),
		[1, 2],
	);
	await assert.rejects(
		upload.complete([first, { partNumber: 2, etag: "0".repeat(32) }]),
		(error) => error.code === "InvalidPart" && error.status === 400,
	);
	const object = await upload.complete([second, first]);
	assert.equal(object.size, 7);
	assert.match(object.etag, /-2$/);
	assert.deepEqual(object.customMetadata, { backupId: "b1" });
	const resumed = bucket.resumeMultipartUpload("backups/database/b1.json", upload.uploadId);
	await resumed.abort();
	await assert.rejects(upload.uploadPart(0, "x"), /Invalid part number/);
});

test("a 200 response that carries an <Error> fails the completion", async () => {
	const upload = await bucket.createMultipartUpload("drive/error200");
	const part = await upload.uploadPart(1, "data");
	fake.state.failNextComplete = "error200";
	await assert.rejects(upload.complete([part]), (error) => error.code === "InternalError");
	await upload.abort();
});

test("list pages through ListObjectsV2 with a cursor", async () => {
	for (const name of ["a", "b", "c"]) await bucket.put(`imports/list/${name}`, name);
	const first = await bucket.list({ prefix: "imports/list/", limit: 2 });
	assert.deepEqual(
		first.objects.map((object) => object.key),
		["imports/list/a", "imports/list/b"],
	);
	assert.equal(first.truncated, true);
	const second = await bucket.list({ prefix: "imports/list/", limit: 2, cursor: first.cursor });
	assert.deepEqual(
		second.objects.map((object) => [object.key, object.size]),
		[["imports/list/c", 1]],
	);
	assert.equal(second.truncated, false);
});

test("copy duplicates an object inside the store", async () => {
	await bucket.put("attachments/source", "copy me", { httpMetadata: { contentType: "text/plain" } });
	await bucket.copy("attachments/source", "drive/copied");
	assert.equal(await (await bucket.get("drive/copied")).text(), "copy me");
	await assert.rejects(bucket.copy("attachments/none", "drive/none"), (error) => error.status === 404);
});

test("virtual-hosted addressing puts the bucket in the host name", async () => {
	const virtual = new S3Bucket(config({ addressing: "virtual" }), { fetch: inProcess });
	assert.equal(virtual.origin, `http://kite-test.${fake.endpoint}`);
	await virtual.put("drive/virtual", "v");
	assert.equal(await (await virtual.get("drive/virtual")).text(), "v");
	const request = fake.state.requests.findLast((entry) => entry.method === "GET");
	assert.equal(request.host, `kite-test.${fake.endpoint}`);
	assert.equal(request.path, "/drive/virtual");
});

test("store errors surface as AwsError: a wrong secret and a denied action", async () => {
	const wrong = new S3Bucket(config({ secretAccessKey: "not-the-secret" }));
	await assert.rejects(wrong.head("drive/x"), (error) => error.status === 403);
	await assert.rejects(wrong.get("drive/x"), (error) => error.code === "SignatureDoesNotMatch");
	fake.state.denied.add("DeleteObject");
	try {
		await bucket.put("drive/locked", "x");
		await assert.rejects(bucket.delete("drive/locked"), (error) => error.code === "AccessDenied" && error.accessDenied);
	} finally {
		fake.state.denied.delete("DeleteObject");
	}
	const missing = new S3Bucket(config({ bucket: "no-such-bucket" }));
	await assert.rejects(missing.headBucket(), (error) => error.status === 404);
	await bucket.headBucket();
});

test("presigned URLs work without credentials and pin the upload size", async () => {
	await bucket.put("drive/presigned", "secret bytes", { httpMetadata: { contentType: "text/html" } });
	const get = await bucket.signer.presignGet("drive/presigned", {
		expiresIn: 300,
		filename: "résumé.html",
		disposition: "attachment",
		contentType: "application/octet-stream",
	});
	const response = await fetch(get);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "secret bytes");
	assert.equal(response.headers.get("content-type"), "application/octet-stream");
	assert.match(response.headers.get("content-disposition"), /^attachment; .*filename\*=UTF-8''r%C3%A9sum%C3%A9\.html$/);

	const put = await bucket.signer.presignPut("drive/browser", { expiresIn: 900, contentLength: 4, contentType: "x/y" });
	assert.equal((await fetch(put, { method: "PUT", body: "four" })).status, 200);
	assert.equal((await fetch(put, { method: "PUT", body: "longer" })).status, 403, "a different size is refused");

	const upload = await bucket.createMultipartUpload("drive/browser-parts");
	const partUrl = await bucket.signer.presignUploadPart("drive/browser-parts", upload.uploadId, 1, {
		expiresIn: 900,
		contentLength: 3,
	});
	const part = await fetch(partUrl, { method: "PUT", body: "abc" });
	assert.equal(part.status, 200);
	const object = await upload.complete([{ partNumber: 1, etag: part.headers.get("etag") }]);
	assert.equal(object.size, 3);
	await assert.rejects(bucket.signer.presignPut("drive/x", { expiresIn: 3601, contentLength: 1, contentType: "" }));
});

test("bucket CORS and lifecycle rules are written with a checksum", async () => {
	await bucket.putCors(["https://mail.example.com"]);
	assert.deepEqual(fake.buckets.get("kite-test").cors[0].origins, ["https://mail.example.com"]);
	await bucket.putAbortIncompleteUploadsLifecycle(7);
	assert.match(fake.buckets.get("kite-test").lifecycle, /<DaysAfterInitiation>7</);
	const request = fake.state.requests.findLast((entry) => entry.query.lifecycle !== undefined);
	assert.ok(request.headers["x-amz-checksum-sha256"]);
});

test("metadata helpers refuse names S3 cannot carry and keep camelCase names", () => {
	assert.throws(() => utils.metadataHeaders(undefined, { "bad name": "x" }), /Invalid metadata name/);
	assert.throws(() => utils.metadataHeaders(undefined, { "kite-keys": "x" }), /Invalid metadata name/);
	const headers = utils.metadataHeaders(
		new Headers({ "content-type": "text/plain", "content-disposition": 'attachment; filename="ü"' }),
		{ userId: "u1", name: "ä%" },
	);
	assert.equal(headers["x-amz-meta-kite-keys"], "userId");
	assert.equal(headers["Content-Disposition"], 'attachment; filename="%C3%BC"');
	const read = utils.readMetadata(
		new Headers({ "x-amz-meta-userid": "u1", "x-amz-meta-name": "%E4%25bad%", "x-amz-meta-kite-keys": "userId" }),
	);
	assert.deepEqual(read.customMetadata, { userId: "u1", name: "%E4%25bad%" });
	assert.equal(utils.rangeHeader(undefined), null);
	assert.equal(utils.servedRange(new Headers()), undefined);
	assert.deepEqual(utils.toHttpMetadata(undefined), {});
	assert.equal(utils.errorInBody("<Result/>"), null);
	assert.deepEqual(utils.errorInBody("<Error></Error>"), { code: "InternalError", message: "The store failed" });
	assert.deepEqual(utils.parseListObjects("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"), {
		objects: [],
		truncated: false,
		cursor: undefined,
	});
	assert.match(utils.corsRuleJson(["https://a.example"]), /"ExposeHeaders": \[\s+"ETag"/);
	assert.equal(utils.bucketPath({ bucket: "b", addressing: "virtual" }), "/");
	assert.equal(utils.objectPath({ bucket: "b", addressing: "path" }, "a b/c!"), "/b/a%20b/c%21");
});
