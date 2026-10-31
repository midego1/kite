import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { FileBucket } = await bundleModules("kite-file-bucket-", [["FileBucket", "server/runtime/file-bucket.ts"]]);

const root = mkdtempSync(join(tmpdir(), "kite-file-bucket-"));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const bucket = () => new FileBucket(join(root, `bucket-${++counter}`));

function streamOf(...chunks) {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
			controller.close();
		},
	});
}

test("put streams a ReadableStream to disk and keeps the metadata", async () => {
	const files = bucket();
	const stored = await files.put("drive/item-1", streamOf("hello ", "world"), {
		httpMetadata: { contentType: "text/plain" },
		customMetadata: { origin: "test" },
	});
	assert.equal(stored.size, 11);
	const object = await files.get("drive/item-1");
	assert.equal(await object.text(), "hello world");
	assert.equal(object.httpMetadata.contentType, "text/plain");
	assert.deepEqual(object.customMetadata, { origin: "test" });
	const ranged = await files.get("drive/item-1", { range: { offset: 6, length: 5 } });
	assert.equal(await new Response(ranged.body).text(), "world");
});

test("put accepts strings, buffers, views, blobs and null", async () => {
	const files = bucket();
	await files.put("a", "text");
	await files.put("b", new TextEncoder().encode("view"));
	await files.put("c", new TextEncoder().encode("buffer").buffer);
	await files.put("d", new Blob(["blob"]));
	await files.put("e", null);
	assert.deepEqual(await Promise.all(["a", "b", "c", "d", "e"].map(async (key) => (await files.get(key)).text())), [
		"text",
		"view",
		"buffer",
		"blob",
		"",
	]);
});

test("a failed stream leaves no object and no partial file behind", async () => {
	const files = bucket();
	const failing = new ReadableStream({
		pull(controller) {
			controller.error(new Error("connection lost"));
		},
	});
	await assert.rejects(files.put("drive/broken", failing), /connection lost/);
	assert.equal(await files.head("drive/broken"), null);
	const listed = await files.list({ prefix: "drive/" });
	assert.deepEqual(listed.objects, []);
});

test("multipart uploads concatenate parts in part order and remove their scratch directory", async () => {
	const files = bucket();
	const upload = await files.createMultipartUpload("drive/big", { httpMetadata: { contentType: "video/mp4" } });
	const second = await upload.uploadPart(2, streamOf("second"));
	const first = await files.resumeMultipartUpload("drive/big", upload.uploadId).uploadPart(1, streamOf("first-"));
	const object = await upload.complete([second, first]);
	assert.equal(object.size, 12);
	assert.equal(await (await files.get("drive/big")).text(), "first-second");
	assert.equal((await files.head("drive/big")).httpMetadata.contentType, "video/mp4");
	assert.equal(existsSync(join(root, `bucket-${counter}`, ".multipart", upload.uploadId)), false);
});

test("completing with a wrong etag, a missing part or another key is refused", async () => {
	const files = bucket();
	const upload = await files.createMultipartUpload("drive/x");
	const part = await upload.uploadPart(1, streamOf("abc"));
	await assert.rejects(upload.complete([{ partNumber: 1, etag: "1-ff" }]), /Invalid part 1/);
	await assert.rejects(upload.complete([part, { partNumber: 2, etag: "2-3" }]), /Invalid part 2/);
	await assert.rejects(upload.complete([]), /at least one part/);
	await assert.rejects(files.resumeMultipartUpload("drive/other", upload.uploadId).complete([part]), /another key/);
	await assert.rejects(upload.uploadPart(0, "x"), /Invalid part number/);
	assert.throws(() => files.resumeMultipartUpload("drive/x", "../escape"), /Invalid multipart upload id/);
	assert.equal(await files.head("drive/x"), null);
});

test("abort discards the parts and the object never appears", async () => {
	const files = bucket();
	const upload = await files.createMultipartUpload("drive/gone");
	await upload.uploadPart(1, "data");
	await upload.abort();
	assert.equal(await files.head("drive/gone"), null);
	await assert.rejects(upload.uploadPart(2, "more"));
});

test("list pages through keys by prefix in lexical order and skips sidecars and uploads in progress", async () => {
	const files = bucket();
	for (const key of ["drive/b", "drive/a", "drive/c", "inbound/1", "avatars/u"]) await files.put(key, key);
	await files.createMultipartUpload("drive/pending");
	const first = await files.list({ prefix: "drive/", limit: 2 });
	assert.deepEqual(
		first.objects.map((object) => object.key),
		["drive/a", "drive/b"],
	);
	assert.equal(first.truncated, true);
	const second = await files.list({ prefix: "drive/", limit: 2, cursor: first.cursor });
	assert.deepEqual(
		second.objects.map((object) => object.key),
		["drive/c"],
	);
	assert.equal(second.truncated, false);
	assert.equal(second.cursor, undefined);
	assert.equal((await files.list()).objects.length, 5);
	assert.ok(readdirSync(join(root, `bucket-${counter}`)).includes(".multipart"));
});

test("keys cannot escape the bucket root", async () => {
	const files = bucket();
	await assert.rejects(files.put("../outside", "x"), /escapes the bucket root/);
	await assert.rejects(files.createMultipartUpload("../outside"), /escapes the bucket root/);
});

test("conditional puts follow R2: a stale etag or an existing object refuses the write and returns null", async () => {
	const files = bucket();
	const created = await files.put("state.json", "one", { onlyIf: { etagDoesNotMatch: "*" } });
	assert.ok(created);
	assert.equal(await files.put("state.json", "two", { onlyIf: { etagDoesNotMatch: "*" } }), null, "create-only");
	const updated = await files.put("state.json", "two", { onlyIf: { etagMatches: created.etag } });
	assert.ok(updated);
	assert.notEqual(updated.etag, created.etag, "the same size written again still gets a new etag");
	assert.equal(await files.put("state.json", "three", { onlyIf: { etagMatches: created.etag } }), null, "stale");
	assert.equal(await (await files.get("state.json")).text(), "two");
	assert.equal(await files.put("missing.json", "x", { onlyIf: { etagMatches: "*" } }), null);
	assert.deepEqual(
		readdirSync(join(root, `bucket-${counter}`)).filter((name) => name.includes(".partial")),
		[],
	);

	// Writers racing on one version: exactly one wins.
	const results = await Promise.all(
		["a", "b", "c", "d"].map((value) => files.put("state.json", value, { onlyIf: { etagMatches: updated.etag } })),
	);
	assert.equal(results.filter(Boolean).length, 1);
});
