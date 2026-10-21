import assert from "node:assert/strict";
import test from "node:test";
import { loadStorageServices } from "./support/storage-services.mjs";

const { lib, fake, fixture, addStore } = await loadStorageServices("kite-drive-direct-", ["kite-drive"], {
	driveObjects: "src/lib/drive/objects.ts",
});
const { driveUploads, driveContent } = lib;

const owner = { id: "owner", email: "owner@example.com", name: "Owner", role: "admin", isPrimaryAdmin: true };
const bucket = () => fake.buckets.get("kite-drive");

async function driveOnStore(t) {
	const context = await fixture(t);
	await addStore(context.env, "sto_drive", "kite-drive");
	context.db.db
		.prepare(
			"INSERT INTO storage_routes (object_class, store_id, previous_store_id, updated_at) VALUES ('drive', 'sto_drive', 'default', 1)",
		)
		.run();
	lib.config.clearStorageConfigCache();
	return context;
}

function unwrap(answer) {
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	return answer.body;
}

const statusOf = (answer) => answer.status;

const partRequest = (body) =>
	new Request("http://localhost:3200/api/drive/uploads/x/parts/1", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

test("browser transfers require HTTPS except explicitly enabled development loopback", () => {
	const signer = (origin) => ({ origin });
	const https = signer("https://s3.example.com");
	assert.equal(lib.driveObjects.browserSigner({}, { signer: https }), https);
	assert.equal(lib.driveObjects.browserSigner({}, null), undefined);
	const enabled = { STORAGE_ALLOW_INSECURE_ENDPOINT: "1", STORAGE_ALLOW_PRIVATE_ENDPOINTS: "1", KITE_RUNTIME: "node" };
	for (const origin of ["http://s3.example.com", "http://10.0.0.1:9000"])
		assert.equal(lib.driveObjects.browserSigner(enabled, { signer: signer(origin) }), undefined);
	const loopback = signer("http://127.0.0.1:9000");
	assert.equal(lib.driveObjects.browserSigner({}, { signer: loopback }), undefined);
	assert.equal(lib.driveObjects.browserSigner(enabled, { signer: loopback }), loopback);
	const previous = process.env.NODE_ENV;
	try {
		process.env.NODE_ENV = "production";
		assert.equal(lib.driveObjects.browserSigner(enabled, { signer: loopback }), undefined);
	} finally {
		if (previous === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previous;
	}
});

test("an HTTP store without the dev exception proxies new and resumed uploads and large downloads", async (t) => {
	const { env, db } = await driveOnStore(t);
	delete env.STORAGE_ALLOW_INSECURE_ENDPOINT;
	lib.config.clearStorageConfigCache();
	const bytes = Buffer.from("proxied HTTP store bytes");
	const body = uploadBody(bytes);
	const session = unwrap(await driveUploads.startUpload(env, owner, body));
	assert.equal(session.mode, "proxied");
	assert.equal(session.partSize, 32 * 1024 * 1024);
	const resumed = unwrap(await driveUploads.startUpload(env, owner, body));
	assert.equal(resumed.id, session.id);
	assert.equal(resumed.mode, "proxied");
	assert.equal(resumed.resumed, true);
	assert.equal(statusOf(await driveUploads.presignUploadParts(env, owner, session.id, { partNumbers: [1] })), 409);
	assert.equal(
		statusOf(await driveUploads.putUploadPart(env, owner, session.id, 1, partRequest({ etag: "abc" }))),
		409,
	);
	unwrap(
		await driveUploads.putUploadPart(
			env,
			owner,
			session.id,
			1,
			new Request("http://localhost:3200/api/drive/uploads/x/parts/1", {
				method: "PUT",
				headers: { "Content-Length": String(bytes.length) },
				body: bytes,
			}),
		),
	);
	unwrap(await driveUploads.completeUpload(env, owner, session.id));
	assert.equal(bucket().objects.get(`drive/${session.id}`).bytes.toString(), bytes.toString());
	const large = Buffer.alloc(driveContent.DRIVE_PRESIGNED_DOWNLOAD_BYTES, 7);
	await insertReadyFile(env, db, "drv_large", "large.bin", large);
	const download = await driveContent.userFileResponse(
		env,
		owner,
		new Request("http://localhost:3200/api/drive/files/drv_large/content?disposition=attachment"),
		"drv_large",
	);
	assert.equal(download.status, 200);
	assert.equal(download.headers.get("Location"), null);
	assert.deepEqual(Buffer.from(await download.arrayBuffer()), large);
});

test("a direct upload sends parts to the store with signed URLs and completes with the reported ETags", async (t) => {
	const { env } = await driveOnStore(t);
	const bytes = Buffer.from("direct upload bytes, invented");
	const session = unwrap(await driveUploads.startUpload(env, owner, uploadBody(bytes)));
	assert.equal(session.mode, "direct");
	assert.equal(session.parts, 1);

	const signed = unwrap(await driveUploads.presignUploadParts(env, owner, session.id, { partNumbers: [1] }));
	assert.equal(signed.urls.length, 1);
	const url = new URL(signed.urls[0].url);
	assert.equal(url.host, fake.endpoint);
	assert.ok(url.searchParams.get("X-Amz-Signature"));

	const put = await fetch(url, { method: "PUT", body: bytes });
	assert.equal(put.status, 200);
	const etag = put.headers.get("ETag");
	assert.ok(etag);

	unwrap(await driveUploads.putUploadPart(env, owner, session.id, 1, partRequest({ etag })));
	const done = unwrap(await driveUploads.completeUpload(env, owner, session.id));
	assert.equal(done.complete, true);
	const stored = [...bucket().objects.values()];
	assert.equal(stored.length, 1);
	assert.equal(stored[0].bytes.toString(), bytes.toString());
});

test("a wrong reported ETag fails completion instead of storing a broken file", async (t) => {
	const { env } = await driveOnStore(t);
	const bytes = Buffer.from("another invented file");
	const session = unwrap(await driveUploads.startUpload(env, owner, uploadBody(bytes)));
	const [{ url }] = unwrap(await driveUploads.presignUploadParts(env, owner, session.id, { partNumbers: [1] })).urls;
	await fetch(url, { method: "PUT", body: bytes });
	unwrap(await driveUploads.putUploadPart(env, owner, session.id, 1, partRequest({ etag: "0000aaaa" })));
	const done = await driveUploads.completeUpload(env, owner, session.id);
	assert.notEqual(statusOf(done), 200);
	assert.equal(bucket().objects.size, 0);
});

test("part URLs are refused for out-of-range parts and for uploads that go through Kite", async (t) => {
	const { env } = await driveOnStore(t);
	const session = unwrap(await driveUploads.startUpload(env, owner, uploadBody(Buffer.from("x"))));
	assert.equal(statusOf(await driveUploads.presignUploadParts(env, owner, session.id, { partNumbers: [2] })), 400);
	assert.equal(statusOf(await driveUploads.presignUploadParts(env, owner, "drv_missing", { partNumbers: [1] })), 404);

	const proxied = await fixture(t);
	const local = unwrap(await driveUploads.startUpload(proxied.env, owner, uploadBody(Buffer.from("y"), "local.bin")));
	assert.equal(local.mode, "proxied");
	assert.equal(
		statusOf(await driveUploads.presignUploadParts(proxied.env, owner, local.id, { partNumbers: [1] })),
		409,
	);
	assert.equal(
		statusOf(await driveUploads.putUploadPart(proxied.env, owner, local.id, 1, partRequest({ etag: "abc" }))),
		409,
	);
});

test("large downloads redirect to a short signed URL that forces an attachment; small ones stream", async (t) => {
	const { env, db } = await driveOnStore(t);
	const large = Buffer.alloc(driveContent.DRIVE_PRESIGNED_DOWNLOAD_BYTES, 7);
	await insertReadyFile(env, db, "drv_large", "large.html", large);
	await insertReadyFile(env, db, "drv_small", "small.txt", Buffer.from("small invented"));

	const download = (id, headers = {}) =>
		driveContent.userFileResponse(
			env,
			owner,
			new Request(`http://localhost:3200/api/drive/files/${id}/content?disposition=attachment`, { headers }),
			id,
		);

	const redirect = await download("drv_large");
	assert.equal(redirect.status, 302);
	assert.equal(redirect.headers.get("Cache-Control"), "no-store");
	assert.equal(redirect.headers.get("Referrer-Policy"), "no-referrer");
	const location = new URL(redirect.headers.get("Location"));
	assert.equal(location.host, fake.endpoint);
	assert.equal(location.searchParams.get("X-Amz-Expires"), "300");
	const fetched = await fetch(location);
	assert.equal(fetched.status, 200);
	assert.equal(fetched.headers.get("Content-Type"), "application/octet-stream");
	assert.match(fetched.headers.get("Content-Disposition"), /^attachment/);
	assert.equal((await fetched.arrayBuffer()).byteLength, large.length);

	assert.equal((await download("drv_large", { Range: "bytes=0-9" })).status, 206);
	const small = await download("drv_small");
	assert.equal(small.status, 200);
	assert.equal(await small.text(), "small invented");
	const inline = await driveContent.userFileResponse(
		env,
		owner,
		new Request("http://localhost:3200/api/drive/files/drv_large/content"),
		"drv_large",
	);
	assert.equal(inline.status, 200);
	await inline.body?.cancel();
});

function uploadBody(bytes, name = "report.bin") {
	return {
		name,
		size: bytes.length,
		contentType: "application/octet-stream",
		parentId: null,
		fingerprint: `fp-${name}`,
	};
}

async function insertReadyFile(env, db, id, name, bytes) {
	db.db
		.prepare(
			`INSERT INTO drive_items (id, owner_id, kind, name, size, content_type, store_id, object_key, status, created_at, updated_at)
			 VALUES (?, 'owner', 'file', ?, ?, 'text/html', 'sto_drive', ?, 'ready', 1, 1)`,
		)
		.run(id, name, bytes.length, `drive/${id}`);
	bucket().objects.set(`drive/${id}`, {
		bytes,
		etag: "1234abcd",
		lastModified: new Date(),
		meta: { contentType: "text/html", custom: {} },
	});
}
