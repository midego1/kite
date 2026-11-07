import assert from "node:assert/strict";
import test from "node:test";
import { withFontFetchRetry } from "../scripts/font-fetch-retry.mjs";

const FONT_CSS = "https://fonts.googleapis.com/css2?family=Inter&display=swap";
const FONT_FILE = "https://fonts.gstatic.com/s/inter/v1/inter.woff2";

function scripted(...steps) {
	const calls = [];
	const base = async (input) => {
		calls.push(String(input));
		const step = steps[Math.min(calls.length, steps.length) - 1];
		if (step instanceof Error) throw step;
		return new Response("", { status: step });
	};
	return { base, calls };
}

const options = (sleeps) => ({ sleep: async (ms) => void sleeps.push(ms) });

test("a rejected font request is retried until it succeeds", async () => {
	const { base, calls } = scripted(new TypeError("fetch failed"), new TypeError("fetch failed"), 200);
	const sleeps = [];
	const response = await withFontFetchRetry(base, options(sleeps))(FONT_CSS);
	assert.equal(response.status, 200);
	assert.equal(calls.length, 3);
	assert.deepEqual(sleeps, [500, 1000]);
});

test("a transient server status is retried, and the last response is returned once the attempts run out", async () => {
	const { base, calls } = scripted(503);
	const response = await withFontFetchRetry(base, { ...options([]), attempts: 3 })(FONT_FILE);
	assert.equal(response.status, 503);
	assert.equal(calls.length, 3);
});

test("a request that keeps being rejected rejects with its own error", async () => {
	const failure = new TypeError("fetch failed");
	const { base, calls } = scripted(failure);
	await assert.rejects(withFontFetchRetry(base, { ...options([]), attempts: 2 })(FONT_CSS), failure);
	assert.equal(calls.length, 2);
});

test("a definite answer such as 404 is not retried", async () => {
	const { base, calls } = scripted(404);
	assert.equal((await withFontFetchRetry(base, options([]))(FONT_CSS)).status, 404);
	assert.equal(calls.length, 1);
});

test("requests to other hosts, and unparseable inputs, pass through untouched", async () => {
	const { base, calls } = scripted(new TypeError("fetch failed"));
	const wrapped = withFontFetchRetry(base, options([]));
	await assert.rejects(wrapped("https://example.com/css"));
	await assert.rejects(wrapped("not a url"));
	assert.equal(calls.length, 2);
});

test("a Request object is matched by its URL", async () => {
	const { base, calls } = scripted(new TypeError("fetch failed"), 200);
	const response = await withFontFetchRetry(base, options([]))(new Request(FONT_CSS));
	assert.equal(response.status, 200);
	assert.equal(calls.length, 2);
});
