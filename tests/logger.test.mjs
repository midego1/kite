import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "../src/lib/logger.mjs";

test("logs are parseable JSON with timestamp, severity, component and event", () => {
	const lines = [];
	const logger = createLogger("test", { level: "debug", sink: (line) => lines.push(JSON.parse(line)) });
	logger.debug("queue.started", { attempts: 1 });
	assert.equal(lines[0].component, "test");
	assert.equal(lines[0].level, "debug");
	assert.equal(lines[0].event, "queue.started");
	assert.ok(Number.isFinite(Date.parse(lines[0].timestamp)));
	assert.deepEqual(lines[0].fields, { attempts: 1 });
});

test("log levels filter routine output while retaining failures", () => {
	const lines = [];
	const logger = createLogger("test", { level: "warn", sink: (line) => lines.push(JSON.parse(line)) });
	logger.debug("hidden");
	logger.info("hidden");
	logger.warn("warning");
	logger.error("failure");
	assert.deepEqual(
		lines.map((line) => line.event),
		["warning", "failure"],
	);
});

test("nested credentials and mail fields are redacted and exception messages are omitted", () => {
	const lines = [];
	const logger = createLogger("test", { sink: (line) => lines.push(line) });
	logger.error("failed", {
		secret: "private-secret",
		nested: { authorization: "Bearer abc", recipients: ["private@example.com"], headers: { cookie: "session" } },
		error: new Error("token=private-secret"),
		count: 1,
	});
	assert.doesNotMatch(lines[0], /private-secret|Bearer abc|private@example/);
	assert.equal(JSON.parse(lines[0]).fields.error.type, "Error");
	assert.equal(JSON.parse(lines[0]).fields.count, 1);
});

test("circular metadata and big integers do not interrupt failure handling", () => {
	const lines = [];
	const value = { id: 12n };
	value.self = value;
	createLogger("test", { sink: (line) => lines.push(line) }).error("failed", { value });
	assert.deepEqual(JSON.parse(lines[0]).fields.value, { id: "12", self: "[Circular]" });
});

test("invalid inherited level names fall back to info", () => {
	const previous = process.env.LOG_LEVEL;
	try {
		process.env.LOG_LEVEL = "constructor";
		const lines = [];
		const logger = createLogger("test", { sink: (line) => lines.push(JSON.parse(line)) });
		logger.debug("hidden");
		logger.info("visible");
		assert.deepEqual(
			lines.map((line) => line.event),
			["visible"],
		);
	} finally {
		if (previous === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = previous;
	}
});

test("non-Error thrown values cannot leak through error metadata", () => {
	const lines = [];
	const logger = createLogger("test", { sink: (line) => lines.push(line) });
	logger.error("failed", { error: "private-secret" });
	logger.error("failed", { error: { message: "private-secret" } });
	assert.doesNotMatch(lines.join("\n"), /private-secret/);
	assert.equal(JSON.parse(lines[0]).fields.error.type, "string");
	assert.equal(JSON.parse(lines[1]).fields.error.type, "object");
});

test("default console transports emit JSON at matching severities", (t) => {
	const emitted = [];
	for (const method of ["log", "warn", "error"])
		t.mock.method(console, method, (line) => emitted.push({ method, entry: JSON.parse(line) }));
	const logger = createLogger("test", { level: "debug" });
	logger.debug("debug", { metadata: [1, { count: 2 }] });
	logger.info("info");
	logger.warn("warn");
	logger.error("error");
	assert.deepEqual(
		emitted.map((item) => item.method),
		["log", "log", "warn", "error"],
	);
	assert.deepEqual(emitted[0].entry.fields.metadata, [1, { count: 2 }]);
});

test("errors keep a code-shaped code but drop codes that could carry free text", () => {
	const lines = [];
	const logger = createLogger("test", { sink: (line) => lines.push(JSON.parse(line)) });
	const withCode = (code) => Object.assign(new TypeError("private@example.com rejected"), { code });
	logger.error("failed", { error: withCode("ECONNRESET") });
	logger.error("failed", { error: withCode(7) });
	logger.error("failed", { error: withCode("private@example.com") });
	logger.error("failed", { error: withCode("token is private-secret") });
	logger.error("failed", { error: withCode({ nested: "private-secret" }) });
	assert.deepEqual(lines[0].fields.error, { type: "TypeError", code: "ECONNRESET" });
	assert.deepEqual(lines[1].fields.error, { type: "TypeError", code: 7 });
	for (const line of lines.slice(2)) assert.deepEqual(line.fields.error, { type: "TypeError" });
	assert.doesNotMatch(JSON.stringify(lines), /private/);
});
