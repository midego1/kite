import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { bundleModules, root } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	getDb,
	createInvoker,
	buildCallContext,
	MODULE_CAPABILITIES,
	MODULE_MANIFESTS,
	jmapModuleSurface,
	moduleMethodResult,
	NO_JMAP_MODULES,
	buildSession,
	processRequest,
	validateRequest,
} = await bundleModules("kite-module-jmap-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["getDb", "src/db/index.ts"],
	["createInvoker", "src/lib/modules/invoke-utils.ts"],
	["buildCallContext", "src/lib/modules/capability-utils.ts"],
	["MODULE_CAPABILITIES", "src/lib/modules/capability-registry.ts"],
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
	["jmapModuleSurface, moduleMethodResult, NO_JMAP_MODULES", "src/lib/jmap/module-utils.ts"],
	["buildSession", "src/lib/jmap/session.ts"],
	["processRequest, validateRequest", "src/lib/jmap/processor.ts"],
]);

const URN = "urn:test:calendars";
const CORE_URNS = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"].sort();

const testModule = {
	moduleId: "calendar",
	promptFragment: null,
	descriptors: [
		{
			name: "calendars",
			surfaces: ["jmap_capability"],
			description: "Test capability",
			inputSchema: {},
			effect: "none",
			jmap: { urn: URN, capability: { maxCalendars: 3 } },
		},
		{
			name: "Calendar/get",
			surfaces: ["jmap_method"],
			description: "Test method",
			inputSchema: {},
			scopes: ["calendar.read"],
			effect: "read",
			jmap: { method: "Calendar/get" },
		},
		{
			name: "Calendar/fail",
			surfaces: ["jmap_method"],
			description: "Test method that throws",
			inputSchema: {},
			effect: "read",
			jmap: { method: "Calendar/fail" },
		},
	],
};
const ALL_CAPABILITIES = [...MODULE_CAPABILITIES, testModule];

const seen = [];
let enabled = true;
const invoke = createInvoker({
	lookup: (moduleId, name) => {
		const descriptor = testModule.descriptors.find((item) => item.name === name);
		if (moduleId !== "calendar" || !descriptor) return null;
		return {
			descriptor,
			handler: async (input, ctx) => {
				seen.push({ input, ctx });
				if (name === "Calendar/fail") throw new Error("handler exploded");
				return { accountId: input.accountId, list: [{ id: "cal-1", echoed: input.args }] };
			},
			inputSchema: z.object({ args: z.record(z.string(), z.unknown()), accountId: z.string() }),
		};
	},
	isEnabled: async () => enabled,
	log: () => undefined,
});

const OWNER = { userId: "owner", role: "admin", isPrimaryAdmin: true };

function surfaceFor(on) {
	const modules = on ? ["calendar"] : [];
	const context = buildCallContext({
		trigger: "api",
		viewer: OWNER,
		timeZone: "UTC",
		enabled: modules,
		manifests: MODULE_MANIFESTS,
	});
	return jmapModuleSurface(ALL_CAPABILITIES, modules, (moduleId, name, input) =>
		invoke(moduleId, name, input, context),
	);
}

async function context(t, modules) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(
		"INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1)",
	);
	const user = { id: "owner", email: "owner@example.com", role: "admin", isPrimaryAdmin: true, disabled: false };
	return {
		env: { DB: database },
		db: getDb({ DB: database }),
		auth: { userId: "owner", email: "owner@example.com", scopes: ["jmap"], mailboxIds: null, user },
		accountId: "owner",
		origin: "https://kite.test",
		createdIds: {},
		modules,
	};
}

const call = (method, args = {}) => ({ using: ["urn:ietf:params:jmap:core"], methodCalls: [[method, args, "c1"]] });

test("while the module is on the session lists its URN in capabilities and accountCapabilities", async (t) => {
	enabled = true;
	const ctx = await context(t, surfaceFor(true));
	const session = buildSession(ctx, "state-1");
	assert.deepEqual(session.capabilities[URN], { maxCalendars: 3 });
	assert.deepEqual(session.accounts.owner.accountCapabilities[URN], { maxCalendars: 3 });
	assert.deepEqual(Object.keys(session.capabilities).sort(), [...CORE_URNS, URN].sort());
});

test("while the module is off the session omits its URN", async (t) => {
	enabled = false;
	const ctx = await context(t, surfaceFor(false));
	const session = buildSession(ctx, "state-1");
	assert.ok(!(URN in session.capabilities));
	assert.ok(!(URN in session.accounts.owner.accountCapabilities));
});

test("a module method is answered through invokeCapability with the handler's output as the response arguments", async (t) => {
	enabled = true;
	seen.length = 0;
	const ctx = await context(t, surfaceFor(true));
	const response = await processRequest(ctx, call("Calendar/get", { ids: ["cal-1"] }));
	assert.deepEqual(response.methodResponses, [
		["Calendar/get", { accountId: "owner", list: [{ id: "cal-1", echoed: { ids: ["cal-1"] } }] }, "c1"],
	]);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].ctx.trigger, "api");
	assert.equal(seen[0].ctx.viewer.userId, "owner");
	assert.deepEqual(seen[0].input, { args: { ids: ["cal-1"] }, accountId: "owner" });
});

test("a module method answers unknownMethod while the module is off", async (t) => {
	enabled = false;
	seen.length = 0;
	const ctx = await context(t, surfaceFor(false));
	const response = await processRequest(ctx, call("Calendar/get", { ids: [] }));
	assert.deepEqual(response.methodResponses, [["error", { type: "unknownMethod" }, "c1"]]);
	assert.equal(seen.length, 0);
});

test("a module disabled after the surface was built still answers unknownMethod", async (t) => {
	enabled = true;
	const ctx = await context(t, surfaceFor(true));
	enabled = false;
	const response = await processRequest(ctx, call("Calendar/get"));
	assert.deepEqual(response.methodResponses, [["error", { type: "unknownMethod" }, "c1"]]);
});

test("a failing module handler answers serverFail without leaking its message", async (t) => {
	enabled = true;
	const ctx = await context(t, surfaceFor(true));
	const response = await processRequest(ctx, call("Calendar/fail"));
	const [name, body] = response.methodResponses[0];
	assert.equal(name, "error");
	assert.equal(body.type, "serverFail");
	assert.ok(!JSON.stringify(body).includes("exploded"));
});

test("a module method cannot replace a core method", async (t) => {
	enabled = true;
	const echoModule = {
		moduleId: "calendar",
		promptFragment: null,
		descriptors: [
			{
				name: "Core/echo",
				surfaces: ["jmap_method"],
				description: "Shadow",
				inputSchema: {},
				effect: "read",
				jmap: { method: "Core/echo" },
			},
		],
	};
	const ctx = await context(
		t,
		jmapModuleSurface([echoModule], ["calendar"], async () => ({ ok: true, output: {} })),
	);
	const response = await processRequest(ctx, call("Core/echo", { hello: "world" }));
	assert.deepEqual(response.methodResponses[0], ["Core/echo", { hello: "world" }, "c1"]);
});

test("the using list accepts an enabled module's URN and refuses it while the module is off", () => {
	const on = surfaceFor(true);
	const off = surfaceFor(false);
	const request = { using: ["urn:ietf:params:jmap:core", URN], methodCalls: [] };
	assert.doesNotThrow(() => validateRequest(request, on));
	assert.throws(
		() => validateRequest(request, off),
		(error) => error.type === "unknownCapability",
	);
	assert.throws(
		() => validateRequest(request),
		(error) => error.type === "unknownCapability",
	);
	assert.doesNotThrow(() => validateRequest({ using: ["urn:ietf:params:jmap:mail"], methodCalls: [] }));
});

test("the real session is the same with every module on, every module off, or no module surface at all", async (t) => {
	const none = buildSession(await context(t, undefined), "s");
	const withNone = buildSession(await context(t, NO_JMAP_MODULES), "s");
	const everyModule = buildSession(
		await context(
			t,
			jmapModuleSurface(
				MODULE_CAPABILITIES,
				["calendar", "booking", "templates", "import", "finance", "drive"],
				async () => ({
					ok: true,
					output: {},
				}),
			),
		),
		"s",
	);
	const noModule = buildSession(
		await context(
			t,
			jmapModuleSurface(MODULE_CAPABILITIES, [], async () => ({ ok: true, output: {} })),
		),
		"s",
	);
	assert.deepEqual(Object.keys(none.capabilities).sort(), CORE_URNS);
	assert.deepEqual(Object.keys(none.accounts.owner.accountCapabilities).sort(), [
		"urn:ietf:params:jmap:mail",
		"urn:ietf:params:jmap:submission",
	]);
	assert.deepEqual(withNone, none);
	assert.deepEqual(everyModule, none);
	assert.deepEqual(noModule, none);
});

test("module capability failures map onto method errors without handler detail", () => {
	const failed = (code, message = "internal detail") => ({ ok: false, error: { code, message } });
	assert.deepEqual(moduleMethodResult(failed("module_disabled")), { type: "unknownMethod" });
	assert.deepEqual(moduleMethodResult(failed("unknown_capability")), { type: "unknownMethod" });
	assert.deepEqual(moduleMethodResult(failed("forbidden")), { type: "forbidden" });
	assert.deepEqual(moduleMethodResult(failed("invalid_input", "ids: required")), {
		type: "invalidArguments",
		description: "ids: required",
	});
	for (const code of ["timeout", "handler_error", "invalid_output", "not_found"])
		assert.deepEqual(moduleMethodResult(failed(code)), { type: "serverFail" }, code);
	assert.deepEqual(moduleMethodResult({ ok: true, output: { list: [] } }), { list: [] });
	assert.deepEqual(moduleMethodResult({ ok: true, output: [1] }), { value: [1] });
	assert.deepEqual(moduleMethodResult({ ok: true, output: null }), { value: null });
});
