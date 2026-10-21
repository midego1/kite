import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { uploadDriveFile, UploadCancelled } = await bundleModules("kite-drive-upload-", [
	["uploadDriveFile, UploadCancelled", "src/components/drive/drive-upload.ts"],
]);

const file = new File(["abcdef"], "test.txt", { type: "text/plain" });
const session = { id: "session", partSize: 2, parts: 3 };

function mockUpload(t, controller, { start = () => {}, send = (request) => request.onload() } = {}) {
	const calls = [];
	const requests = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		calls.push({ url, method: init.method });
		if (url === "/api/drive/uploads") {
			await start();
			return Response.json(session);
		}
		return Response.json({});
	});
	const previous = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
	t.after(() => {
		if (previous) Object.defineProperty(globalThis, "XMLHttpRequest", previous);
		else delete globalThis.XMLHttpRequest;
	});
	globalThis.XMLHttpRequest = class {
		upload = {};
		status = 200;
		open(method, url) {
			requests.push({ method, url });
		}
		setRequestHeader() {}
		send() {
			send(this);
			this.onloadend();
		}
		abort() {
			this.onabort();
			this.onloadend();
		}
	};
	return {
		calls,
		requests,
		assertClean: () => assert.equal(getEventListeners(controller.signal, "abort").length, 0),
	};
}

test("cancelling while the upload session starts sends no parts and discards the session", async (t) => {
	const controller = new AbortController();
	const mocked = mockUpload(t, controller, { start: () => controller.abort() });
	await assert.rejects(
		uploadDriveFile(file, null, () => {}, controller.signal),
		UploadCancelled,
	);
	assert.deepEqual(mocked.requests, []);
	assert.deepEqual(
		mocked.calls.map(({ method }) => method),
		["POST", "DELETE"],
	);
	mocked.assertClean();
});

test("cancelling between parts stops the remaining parts and skips completion", async (t) => {
	const controller = new AbortController();
	const mocked = mockUpload(t, controller);
	await assert.rejects(
		uploadDriveFile(file, null, (percent) => percent > 0 && controller.abort(), controller.signal),
		UploadCancelled,
	);
	assert.equal(mocked.requests.length, 1);
	assert.deepEqual(
		mocked.calls.map(({ method }) => method),
		["POST", "DELETE"],
	);
	mocked.assertClean();
});

test("cancelling an active part aborts it without retrying", async (t) => {
	const controller = new AbortController();
	const mocked = mockUpload(t, controller, { send: () => controller.abort() });
	await assert.rejects(
		uploadDriveFile(file, null, () => {}, controller.signal),
		UploadCancelled,
	);
	assert.equal(mocked.requests.length, 1);
	assert.deepEqual(
		mocked.calls.map(({ method }) => method),
		["POST", "DELETE"],
	);
	mocked.assertClean();
});

test("successful parts remove their abort listeners and complete the upload", async (t) => {
	const controller = new AbortController();
	const mocked = mockUpload(t, controller);
	await uploadDriveFile(file, null, () => mocked.assertClean(), controller.signal);
	assert.equal(mocked.requests.length, 3);
	assert.deepEqual(
		mocked.calls.map(({ method }) => method),
		["POST", "POST"],
	);
	mocked.assertClean();
});

test("failed parts remove their abort listeners on every retry", async (t) => {
	const controller = new AbortController();
	const mocked = mockUpload(t, controller, { send: (request) => request.onerror() });
	await assert.rejects(
		uploadDriveFile(file, null, () => {}, controller.signal),
		/network error/,
	);
	assert.equal(mocked.requests.length, 3);
	assert.deepEqual(
		mocked.calls.map(({ method }) => method),
		["POST"],
	);
	mocked.assertClean();
});

function mockDirectUpload(t, { etag = '"etag-1"', expireFirst = false } = {}) {
	const calls = [];
	const requests = [];
	let urlBatches = 0;
	t.mock.method(globalThis, "fetch", async (url, init) => {
		calls.push({ url, method: init.method, body: init.body });
		if (url === "/api/drive/uploads") return Response.json({ ...session, mode: "direct" });
		if (url.endsWith("/part-urls")) {
			urlBatches += 1;
			const { partNumbers } = JSON.parse(init.body);
			return Response.json({
				urls: partNumbers.map((partNumber) => ({
					partNumber,
					url: `https://store.example.test/bucket/key?partNumber=${partNumber}&batch=${urlBatches}`,
				})),
			});
		}
		return Response.json({});
	});
	const previous = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
	t.after(() => {
		if (previous) Object.defineProperty(globalThis, "XMLHttpRequest", previous);
		else delete globalThis.XMLHttpRequest;
	});
	globalThis.XMLHttpRequest = class {
		upload = {};
		status = 200;
		headers = [];
		withCredentials = true;
		open(method, url) {
			this.entry = { method, url, headers: this.headers };
			requests.push(this.entry);
		}
		setRequestHeader(name) {
			this.headers.push(name);
		}
		getResponseHeader(name) {
			return name === "ETag" ? etag : null;
		}
		send() {
			this.entry.withCredentials = this.withCredentials;
			if (expireFirst && requests.length === 1) {
				this.status = 403;
				this.responseText = "<Error><Code>AccessDenied</Code></Error>";
			}
			this.onload();
			this.onloadend();
		}
		abort() {}
	};
	return { calls, requests };
}

test("direct uploads send parts to the store without Kite headers and record each ETag", async (t) => {
	const mocked = mockDirectUpload(t);
	await uploadDriveFile(file, null, () => {}, new AbortController().signal);
	assert.equal(mocked.requests.length, 3);
	for (const request of mocked.requests) {
		assert.match(request.url, /^https:\/\/store\.example\.test\//);
		assert.deepEqual(request.headers, []);
		assert.equal(request.withCredentials, false);
	}
	const reported = mocked.calls.filter(({ url }) => /\/parts\/\d$/.test(url));
	assert.deepEqual(
		reported.map(({ url, method, body }) => [url, method, JSON.parse(body).etag]),
		[1, 2, 3].map((part) => [`/api/drive/uploads/session/parts/${part}`, "PUT", '"etag-1"']),
	);
	assert.equal(mocked.calls.filter(({ url }) => url.endsWith("/part-urls")).length, 1);
	assert.equal(mocked.calls.at(-1).url, "/api/drive/uploads/session/complete");
});

test("a rejected direct part fetches a fresh URL before retrying", async (t) => {
	const mocked = mockDirectUpload(t, { expireFirst: true });
	await uploadDriveFile(file, null, () => {}, new AbortController().signal);
	assert.equal(mocked.requests.length, 4);
	assert.match(mocked.requests[0].url, /partNumber=1&batch=1$/);
	assert.match(mocked.requests[1].url, /partNumber=1&batch=2$/);
});

test("a direct part without a readable ETag fails instead of completing", async (t) => {
	const mocked = mockDirectUpload(t, { etag: null });
	await assert.rejects(
		uploadDriveFile(file, null, () => {}, new AbortController().signal),
		/ETag/,
	);
	assert.equal(
		mocked.calls.some(({ url }) => url.endsWith("/complete")),
		false,
	);
});
