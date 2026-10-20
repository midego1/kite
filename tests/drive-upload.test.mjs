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
