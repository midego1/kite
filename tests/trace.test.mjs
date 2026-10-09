import assert from "node:assert/strict";
import test from "node:test";
import { createTraceContext, traceHttp } from "../src/lib/trace.mjs";
import { createLogger } from "../src/lib/logger.mjs";

const incoming = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01";
test("valid trace context keeps the trace and creates a child span", () => {
	const trace = createTraceContext(incoming);
	assert.equal(trace.traceId, "1234567890abcdef1234567890abcdef");
	assert.notEqual(trace.spanId, "1234567890abcdef");
	assert.match(trace.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
	assert.equal(createTraceContext(incoming.slice(0, -2) + "00").traceparent.slice(-2), "00");
	assert.equal(createTraceContext(incoming.slice(0, -2) + "ff").traceparent.slice(-2), "01");
});

test("missing, malformed and zero trace IDs start a fresh trace", () => {
	for (const value of [
		undefined,
		null,
		"private@example.com",
		"00-" + "0".repeat(32) + "-1234567890abcdef-01",
		"00-1234567890abcdef1234567890abcdef-" + "0".repeat(16) + "-01",
		incoming.toUpperCase(),
		incoming + "-extra",
		incoming.replace(/^00/, "ff"),
	]) {
		const trace = createTraceContext(value);
		assert.match(trace.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		assert.notEqual(trace.traceId, "0".repeat(32));
		assert.notEqual(trace.traceId, "1234567890abcdef1234567890abcdef");
	}
});

test("HTTP spans propagate context, preserve response and emit duration/status without URL or credentials", async () => {
	const lines = [];
	const logger = createLogger("test", { sink: (line) => lines.push(JSON.parse(line)) });
	const request = new Request("https://example.com/api/inbound?token=private", {
		method: "POST",
		headers: { traceparent: incoming, authorization: "Bearer private" },
		body: "private mail",
	});
	const response = await traceHttp(
		request,
		async (traced) => {
			assert.equal(traced.headers.get("traceparent").split("-")[1], incoming.split("-")[1]);
			assert.equal(await traced.text(), "private mail");
			return new Response("ok", { status: 202, headers: { "X-Test": "kept" } });
		},
		logger,
	);
	assert.equal(response.status, 202);
	assert.equal(response.headers.get("X-Test"), "kept");
	assert.equal(await response.text(), "ok");
	assert.equal(response.headers.get("traceparent").split("-")[1], incoming.split("-")[1]);
	assert.deepEqual(lines, [], "fast successful requests are not logged");
});

test("server errors, slow requests and client errors are logged without URL or credentials", async (t) => {
	const lines = [];
	const logger = createLogger("test", { sink: (line) => lines.push(JSON.parse(line)) });
	const request = () =>
		new Request("https://example.com/api/inbound?token=private", {
			headers: { traceparent: incoming, authorization: "Bearer private" },
		});
	await traceHttp(request(), async () => new Response("no", { status: 503 }), logger);
	await traceHttp(request(), async () => new Response("missing", { status: 404 }), logger);
	const clock = [0, 1500];
	t.mock.method(performance, "now", () => clock.shift() ?? 1500);
	await traceHttp(request(), async () => new Response("ok"), logger);
	assert.deepEqual(
		lines.map((line) => [line.event, line.level, line.fields.status]),
		[
			["http.request_completed", "error", 503],
			["http.request_completed", "info", 404],
			["http.request_completed", "warn", 200],
		],
	);
	assert.equal(lines[2].fields.slow, true);
	assert.equal(lines[2].fields.durationMs, 1500);
	assert.equal(lines[0].fields.traceId, incoming.split("-")[1]);
	assert.ok(lines.every((line) => line.fields.durationMs >= 0));
	assert.doesNotMatch(JSON.stringify(lines), /private|example.com|inbound/);
});

test("HTTP failures retain the original exception and produce a trace event", async () => {
	const lines = [];
	const error = new Error("private credential");
	const logger = createLogger("test", { sink: (line) => lines.push(JSON.parse(line)) });
	await assert.rejects(
		traceHttp(
			new Request("https://example.com"),
			async () => {
				throw error;
			},
			logger,
		),
		(caught) => caught === error,
	);
	assert.equal(lines[0].event, "http.request_failed");
	assert.equal(lines[0].fields.error.type, "Error");
	assert.doesNotMatch(JSON.stringify(lines), /private credential/);
});

test("websocket upgrade responses pass through without reconstruction", async () => {
	const response = { status: 101 };
	const logger = createLogger("test", { sink: () => {} });
	assert.equal(
		await traceHttp(new Request("https://example.com/api/realtime"), async () => response, logger),
		response,
	);
});

test("onComplete receives status and duration, and failures report 500", async () => {
	const logger = createLogger("test", { sink: () => {} });
	const results = [];
	const response = await traceHttp(
		new Request("https://example.com/api/x"),
		async () => new Response("no", { status: 404 }),
		logger,
		(result) => results.push(result),
	);
	assert.equal(response.status, 404);
	await assert.rejects(
		traceHttp(
			new Request("https://example.com/api/x"),
			async () => {
				throw new Error("x");
			},
			logger,
			(result) => results.push(result),
		),
	);
	assert.deepEqual(
		results.map(({ status, failed }) => ({ status, failed })),
		[
			{ status: 404, failed: false },
			{ status: 500, failed: true },
		],
	);
	assert.ok(results.every((result) => Number.isInteger(result.durationMs)));
});

test("an onComplete that throws does not change the response", async () => {
	const logger = createLogger("test", { sink: () => {} });
	const response = await traceHttp(
		new Request("https://example.com/api/x"),
		async () => new Response("ok", { status: 200 }),
		logger,
		() => {
			throw new Error("metrics down");
		},
	);
	assert.equal(response.status, 200);
});
