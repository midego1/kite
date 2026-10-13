import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { bundleModules } from "./support/modules-bundle.mjs";

const { createInvoker, jsonValueProblem, assertJsonValue, invokeCapability, setModuleStateReader } =
	await bundleModules("kite-module-boundary-", [
		["createInvoker", "src/lib/modules/invoke-utils.ts"],
		["jsonValueProblem, assertJsonValue", "src/lib/modules/json-utils.ts"],
		["invokeCapability, setModuleStateReader", "src/lib/modules/invoke.ts"],
	]);

const MODULE = "calendar";
const descriptor = (name, extra = {}) => ({
	name,
	surfaces: ["service"],
	description: name,
	inputSchema: {},
	effect: "read",
	...extra,
});
const entries = new Map();
const calls = [];
const logs = [];
let enabled = true;
let viewersSeen = [];

function register(name, handler, extra = {}, schemas = {}) {
	entries.set(name, {
		descriptor: descriptor(name, extra),
		handler,
		inputSchema: schemas.input ?? z.object({ text: z.string().optional(), count: z.number().int().optional() }),
		outputSchema: schemas.output,
	});
}

const invoke = createInvoker({
	lookup: (moduleId, name) => (moduleId === MODULE ? (entries.get(name) ?? null) : null),
	isEnabled: async (viewer) => {
		viewersSeen.push(viewer);
		return enabled;
	},
	log: (entry) => logs.push(entry),
});

const ctx = (overrides = {}) => ({
	viewer: { userId: "user-1", role: "user", isPrimaryAdmin: false },
	requestId: "req-1",
	locale: "en-GB",
	timeZone: "Europe/London",
	grants: ["test.read", "test.write"],
	trigger: "api",
	...overrides,
});

register("echo", async (input, context) => {
	calls.push({ input, context });
	return { echoed: input };
});
register("noop", async () => ({ ok: true }));
register("write", async () => ({ ok: true }), { scopes: ["test.write", "test.admin"] });
register("mailbox", async () => ({ ok: true }), { mailboxBound: true }, { input: z.object({ mailboxId: z.string() }) });
register("hook", async () => ({ ran: true }), {
	surfaces: ["lifecycle"],
	lifecycle: { event: "user.time_zone_changed", dataHook: true },
});
register("slow", () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 200)), { timeoutMs: 20 });
register("slowReject", () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 60)), {
	timeoutMs: 10,
});
register("throws", async () => {
	throw new Error("secret: password=hunter2");
});
register("throwsSync", () => {
	throw new Error("sync secret");
});
register("badOutput", async () => ({ when: new Date() }));
register("undefinedOutput", async () => undefined);
register("cyclicOutput", async () => {
	const value = {};
	value.self = value;
	return value;
});
register(
	"schemaOutput",
	async () => ({ count: "many" }),
	{},
	{ input: z.object({}), output: z.object({ count: z.number() }) },
);
register(
	"strictOutput",
	async () => ({ count: 3, extra: "dropped" }),
	{},
	{
		input: z.object({}),
		output: z.object({ count: z.number() }),
	},
);

class Point {
	x = 1;
}
const cyclic = {};
cyclic.self = cyclic;
const deep = (levels) => {
	let value = "leaf";
	for (let index = 0; index < levels; index++) value = { next: value };
	return value;
};

test("a valid call passes JSON input and context to the handler and returns its output", async () => {
	calls.length = 0;
	const result = await invoke(MODULE, "echo", { text: "hi", count: 2 }, ctx());
	assert.deepEqual(result, { ok: true, output: { echoed: { text: "hi", count: 2 } } });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].input, { text: "hi", count: 2 });
	assert.equal(calls[0].context.requestId, "req-1");
});

test("handlers receive only the JSON input and a JSON context, never env, a database, a binding, a Request or a function", async () => {
	calls.length = 0;
	await invoke(MODULE, "echo", { text: "hi" }, ctx({ mailboxIds: ["m1"] }));
	const [{ input, context }] = calls;
	assert.equal(jsonValueProblem(input), null);
	assert.equal(jsonValueProblem(context), null);
	assert.deepEqual(Object.keys(context).sort(), [
		"grants",
		"locale",
		"mailboxIds",
		"requestId",
		"timeZone",
		"trigger",
		"viewer",
	]);
	for (const forbidden of ["env", "db", "database", "bindings", "request", "DB", "R2"])
		assert.ok(!(forbidden in context), forbidden);
	assert.equal(JSON.stringify(context).includes("function"), false);
	const handlerArgs = [input, context];
	assert.equal(handlerArgs.length, 2);
	const original = ctx();
	await invoke(MODULE, "echo", {}, original);
	assert.notEqual(calls.at(-1).context, original, "the handler gets a copy of the context");
});

test("input that is not plain JSON is invalid_input", async () => {
	const bad = {
		function: { text: () => "x" },
		"class instance": { text: new Point() },
		Date: { text: new Date() },
		Map: { text: new Map() },
		Set: { text: new Set() },
		undefined: { text: undefined },
		bigint: { count: 1n },
		symbol: { text: Symbol("s") },
		cycle: cyclic,
		NaN: { count: Number.NaN },
		Infinity: { count: Number.POSITIVE_INFINITY },
		"array hole": { items: [1, , 3] },
		"symbol key": { [Symbol("k")]: 1 },
		"top-level undefined": undefined,
		"top-level function": () => 1,
		"depth 33": deep(33),
		"over 1 MiB": { text: "x".repeat(1024 * 1024 + 1) },
	};
	for (const [label, input] of Object.entries(bad)) {
		const result = await invoke(MODULE, "echo", input, ctx());
		assert.equal(result.ok, false, label);
		assert.equal(result.error.code, "invalid_input", label);
	}
	const messages = await Promise.all(
		[deep(33), { text: "x".repeat(1024 * 1024 + 1) }, cyclic].map((input) => invoke(MODULE, "noop", input, ctx())),
	);
	assert.match(messages[0].error.message, /deeper than 32/);
	assert.match(messages[1].error.message, /1 MiB/);
	assert.match(messages[2].error.message, /cycle/);
});

class ListSubclass extends Array {}
const withCallback = () => Object.assign([], { callback: () => "x" });
const withLabel = () => Object.assign([1, 2], { label: "extra" });
const withSymbol = () => Object.assign([1], { [Symbol("k")]: 1 });
const sparseExtra = () => Object.assign([1, 2, 3], { 3: 4 }, { "-1": 0, "01": 0, 1.5: 0 });
const otherPrototype = () => Object.setPrototypeOf([1], null);
const subclass = () => ListSubclass.from([1, 2]);
const nonJsonArrays = {
	"array subclass": subclass,
	"array with a function property": withCallback,
	"array with a string property": withLabel,
	"array with a symbol key": withSymbol,
	"array with non-index numeric-looking keys": sparseExtra,
	"array without the Array prototype": otherPrototype,
};

test("array subclasses and arrays with extra own properties are not JSON, at any depth", () => {
	for (const [label, make] of Object.entries(nonJsonArrays)) {
		for (const wrap of [(v) => v, (v) => ({ items: v }), (v) => [[v]], (v) => ({ a: { b: [v] } })]) {
			assert.notEqual(jsonValueProblem(wrap(make())), null, label);
		}
		assert.throws(() => assertJsonValue(make()), TypeError, label);
	}
	assert.match(jsonValueProblem(subclass()), /ListSubclass/);
	assert.match(jsonValueProblem(withCallback(), "input"), /input/);
	assert.equal(jsonValueProblem([1, [2, { three: [3] }], []]), null);
});

test("arrays that are subclasses or carry extra properties are invalid_input, including under an unknown-valued schema", async () => {
	register("anything", async () => ({ ok: true }), {}, { input: z.unknown() });
	register("anyObject", async () => ({ ok: true }), {}, { input: z.object({ items: z.array(z.unknown()) }) });
	for (const [label, make] of Object.entries(nonJsonArrays)) {
		for (const [name, input] of [
			["noop", make()],
			["echo", { text: "x", items: make() }],
			["anything", make()],
			["anything", { nested: { list: [make()] } }],
			["anyObject", { items: [make()] }],
			["anyObject", { items: make() }],
		]) {
			const result = await invoke(MODULE, name, input, ctx());
			assert.equal(result.ok, false, `${label} -> ${name}`);
			assert.equal(result.error.code, "invalid_input", `${label} -> ${name}`);
		}
	}
	calls.length = 0;
	assert.equal((await invoke(MODULE, "anything", { nested: { list: [[1, 2]] } }, ctx())).ok, true);
});

test("arrays that are subclasses or carry extra properties in a handler's output are invalid_output", async () => {
	register(
		"outputWith",
		async (input) => ({ value: input.make === "subclass" ? subclass() : withCallback() }),
		{},
		{
			input: z.object({ make: z.string() }),
			output: z.object({ value: z.unknown() }),
		},
	);
	register(
		"outputNoSchema",
		async (input) => ({ value: [[Object.assign([], input.extra)]] }),
		{},
		{
			input: z.object({ extra: z.record(z.string(), z.unknown()) }),
		},
	);
	for (const make of ["subclass", "callback"]) {
		const result = await invoke(MODULE, "outputWith", { make }, ctx());
		assert.equal(result.ok, false, make);
		assert.equal(result.error.code, "invalid_output", make);
	}
	const noSchema = await invoke(MODULE, "outputNoSchema", { extra: { flag: true } }, ctx());
	assert.equal(noSchema.ok, false);
	assert.equal(noSchema.error.code, "invalid_output");
	assert.deepEqual(await invoke(MODULE, "outputNoSchema", { extra: {} }, ctx()), {
		ok: true,
		output: { value: [[[]]] },
	});
});

test("inputs at the limits are accepted", async () => {
	assert.equal(jsonValueProblem(deep(32)), null);
	assert.equal(jsonValueProblem(deep(33)) === null, false);
	assert.equal(jsonValueProblem(Object.create(null)), null);
	assert.equal(jsonValueProblem({ list: [null, true, 1.5, "s", { nested: [] }] }), null);
	const result = await invoke(MODULE, "noop", {}, ctx());
	assert.equal(result.ok, true);
	assert.doesNotThrow(() => assertJsonValue({ ok: [1] }));
	assert.throws(() => assertJsonValue(new Date()), /not JSON/);
	assert.throws(() => assertJsonValue(() => 1, "callback"), /callback/);
});

test("a context that is not plain JSON is invalid_input", async () => {
	const result = await invoke(MODULE, "noop", {}, ctx({ requestId: () => "id" }));
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "invalid_input");
	assert.match(result.error.message, /context/);
});

test("schema failures are invalid_input and name the first issue path", async () => {
	const result = await invoke(MODULE, "echo", { text: 5, count: "x" }, ctx());
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "invalid_input");
	assert.match(result.error.message, /^text:/);
	const nested = await invoke(MODULE, "mailbox", {}, ctx({ mailboxIds: ["m1"] }));
	assert.equal(nested.ok, false);
});

test("non-JSON and schema-failing outputs are invalid_output", async () => {
	for (const name of ["badOutput", "undefinedOutput", "cyclicOutput", "schemaOutput"]) {
		const result = await invoke(MODULE, name, {}, ctx());
		assert.equal(result.ok, false, name);
		assert.equal(result.error.code, "invalid_output", name);
	}
	assert.deepEqual(await invoke(MODULE, "strictOutput", {}, ctx()), { ok: true, output: { count: 3 } });
});

test("a missing descriptor or handler is unknown_capability", async () => {
	for (const [moduleId, name] of [
		[MODULE, "missing"],
		["booking", "echo"],
		["nope", "echo"],
	]) {
		const result = await invoke(moduleId, name, {}, ctx());
		assert.deepEqual(result, { ok: false, error: { code: "unknown_capability", message: "Unknown capability" } });
	}
});

test("a disabled module is module_disabled, except for a data hook", async () => {
	enabled = false;
	try {
		viewersSeen = [];
		const result = await invoke(MODULE, "echo", {}, ctx());
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "module_disabled");
		assert.deepEqual(viewersSeen, [ctx().viewer]);
		const hook = await invoke(MODULE, "hook", {}, ctx({ viewer: null }));
		assert.deepEqual(hook, { ok: true, output: { ran: true } });
		assert.equal((await invoke(MODULE, "noop", {}, ctx({ viewer: null }))).error.code, "module_disabled");
	} finally {
		enabled = true;
	}
});

test("missing grants and a mailbox outside ctx.mailboxIds are forbidden", async () => {
	assert.equal((await invoke(MODULE, "write", {}, ctx())).error.code, "forbidden");
	assert.equal((await invoke(MODULE, "write", {}, ctx({ grants: ["test.write"] }))).error.code, "forbidden");
	assert.equal((await invoke(MODULE, "write", {}, ctx({ grants: ["test.write", "test.admin"] }))).ok, true);
	assert.equal((await invoke(MODULE, "write", {}, ctx({ grants: "test.write" }))).error.code, "forbidden");
	const allowed = await invoke(MODULE, "mailbox", { mailboxId: "m1" }, ctx({ mailboxIds: ["m1", "m2"] }));
	assert.equal(allowed.ok, true);
	for (const mailboxIds of [["m2"], [], undefined]) {
		const result = await invoke(MODULE, "mailbox", { mailboxId: "m1" }, ctx({ mailboxIds }));
		assert.equal(result.error.code, "forbidden", String(mailboxIds));
	}
	assert.equal((await invoke(MODULE, "mailbox", {}, ctx({ mailboxIds: ["m1"] }))).error.code, "forbidden");
	assert.equal(
		(await invoke(MODULE, "mailbox", { mailboxId: 4 }, ctx({ mailboxIds: ["m1"] }))).error.code,
		"forbidden",
	);
});

test("a slow handler is timeout, and its later failure is not an unhandled rejection", async () => {
	const result = await invoke(MODULE, "slow", {}, ctx());
	assert.deepEqual(result, {
		ok: false,
		error: { code: "timeout", message: "The capability took too long", retryable: true },
	});
	const rejected = await invoke(MODULE, "slowReject", {}, ctx());
	assert.equal(rejected.error.code, "timeout");
	await new Promise((resolve) => setTimeout(resolve, 120));
});

test("a throwing handler is handler_error without the thrown message, and the details are only logged", async () => {
	logs.length = 0;
	for (const name of ["throws", "throwsSync"]) {
		const result = await invoke(MODULE, name, {}, ctx());
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "handler_error");
		assert.equal(result.error.retryable, true);
		assert.doesNotMatch(JSON.stringify(result), /secret|hunter2|sync/);
	}
	assert.match(String(logs[0].error), /hunter2/);
	assert.equal(logs[0].code, "handler_error");
});

test("invokeCapability never throws or rejects, whatever it is given", async () => {
	const hostile = [
		[null, "echo", {}, ctx()],
		[MODULE, "echo", {}, null],
		[MODULE, "echo", {}, undefined],
		[MODULE, undefined, {}, ctx()],
		[
			MODULE,
			"echo",
			new Proxy(
				{},
				{
					get: () => {
						throw new Error("trap");
					},
					ownKeys: () => {
						throw new Error("trap");
					},
				},
			),
			ctx(),
		],
	];
	for (const args of hostile) {
		const result = await invoke(...args);
		assert.equal(result.ok, false);
		assert.ok(["unknown_capability", "handler_error", "invalid_input", "forbidden"].includes(result.error.code));
	}
	const failing = createInvoker({
		lookup: () => entries.get("noop"),
		isEnabled: async () => {
			throw new Error("state store down");
		},
		log: () => {
			throw new Error("log down");
		},
	});
	assert.deepEqual(await failing(MODULE, "noop", {}, ctx()), {
		ok: false,
		error: { code: "handler_error", message: "The capability failed", retryable: true },
	});
});

test("every call is logged with module, capability, trigger, duration and result code", async () => {
	logs.length = 0;
	let tick = 100;
	const timed = createInvoker({
		lookup: (moduleId, name) => (moduleId === MODULE ? (entries.get(name) ?? null) : null),
		isEnabled: async () => true,
		log: (entry) => logs.push(entry),
		now: () => (tick += 7),
	});
	await timed(MODULE, "noop", {}, ctx({ trigger: "chat" }));
	await timed(MODULE, "missing", {}, ctx({ trigger: "mcp" }));
	assert.deepEqual(logs, [
		{ moduleId: MODULE, capability: "noop", trigger: "chat", durationMs: 7, code: "ok" },
		{ moduleId: MODULE, capability: "missing", trigger: "mcp", durationMs: 7, code: "unknown_capability" },
	]);
});

test("the real registry enforces the same contract", async () => {
	setModuleStateReader(async () => true);
	const readCtx = ctx({ grants: ["calendar.read"], viewer: { userId: "u1", role: "admin", isPrimaryAdmin: true } });
	assert.equal((await invokeCapability("nope", "x", {}, readCtx)).error.code, "unknown_capability");
	assert.equal((await invokeCapability("calendar", "nope", {}, readCtx)).error.code, "unknown_capability");
	assert.equal((await invokeCapability("calendar", "create_event", {}, readCtx)).error.code, "forbidden");
	const invalid = await invokeCapability("calendar", "get_event", {}, readCtx);
	assert.equal(invalid.error.code, "invalid_input");
	assert.match(invalid.error.message, /^eventId:/);
	assert.equal(
		(await invokeCapability("calendar", "get_event", { eventId: () => 1 }, readCtx)).error.code,
		"invalid_input",
	);
	const pending = await invokeCapability(
		"calendar",
		"invite",
		{
			message: { id: "m", mailboxId: "mb", from: "a@b.c", subject: null, receivedAt: "2026-01-01T00:00:00Z" },
			facts: { authPassed: true, bulk: false, knownContact: true, phishing: [] },
			attachments: [],
			model: null,
		},
		readCtx,
	);
	assert.equal(pending.ok, false);
	assert.equal(pending.error.code, "handler_error");
	assert.doesNotMatch(pending.error.message, /implemented/);
	assert.deepEqual(
		await invokeCapability("templates", "resolveRefs", { refs: [] }, ctx({ grants: ["templates.read"] })),
		{ ok: true, output: { results: [] } },
	);
	// Without a database the resolver fails, and the failure never carries a message.
	const noDatabase = await invokeCapability(
		"templates",
		"resolveRefs",
		{ refs: [{ kind: "templates:template", id: "t1" }] },
		ctx({ grants: ["templates.read"] }),
	);
	assert.equal(noDatabase.error.code, "handler_error");
	setModuleStateReader(async (_viewer, moduleId) => moduleId !== "templates");
	try {
		const off = await invokeCapability("templates", "resolveRefs", { refs: [] }, ctx({ grants: ["templates.read"] }));
		assert.equal(off.error.code, "module_disabled");
		const dataHook = await invokeCapability(
			"calendar",
			"timeZoneChanged",
			{ type: "user.time_zone_changed", userId: "u1", from: null, to: "Europe/London" },
			ctx({ grants: [] }),
		);
		assert.deepEqual(dataHook, { ok: true, output: { handled: false } });
	} finally {
		setModuleStateReader(null);
	}
});
