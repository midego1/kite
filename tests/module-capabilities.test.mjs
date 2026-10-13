import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	MODULE_MANIFESTS,
	MODULE_CAPABILITIES,
	listCapabilities,
	selectCapabilities,
	effectiveModules,
	scopeDeclarations,
	clientScopeDeclarations,
	keyScopeOptions,
	allKeyScopes,
	scopeOwner,
	isScopeAvailable,
	scopesNeedMailbox,
	scopeRefusal,
	grantsForMcpScopes,
	mcpToolsFor,
	CLIENT_MODULES,
	CORE_API_KEY_SCOPES,
	CORE_MCP_SCOPES,
} = await bundleModules("kite-module-capabilities-", [
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
	["MODULE_CAPABILITIES, listCapabilities", "src/lib/modules/capability-registry.ts"],
	["selectCapabilities", "src/lib/modules/capability-utils.ts"],
	["effectiveModules", "src/lib/modules/state-utils.ts"],
	[
		"scopeDeclarations, clientScopeDeclarations, keyScopeOptions, allKeyScopes, scopeOwner, isScopeAvailable, scopesNeedMailbox, scopeRefusal, grantsForMcpScopes, mcpToolsFor",
		"src/lib/modules/key-scope-utils.ts",
	],
	["CLIENT_MODULES", "src/lib/modules/client-data/index.ts"],
	["CORE_API_KEY_SCOPES, CORE_MCP_SCOPES", "src/lib/api/scopes.ts"],
]);

const ALL = ["calendar", "booking", "templates", "import"];
const CALENDAR_TOOLS = [
	"get_schedule",
	"search_events",
	"get_event",
	"create_event",
	"update_events",
	"delete_events",
	"find_free_time",
	"get_calendars",
];
const READ_TOOLS = ["get_schedule", "search_events", "get_event", "find_free_time", "get_calendars"];
const names = (listed) => listed.map((item) => item.descriptor.name);
const install = (off = []) => new Map(ALL.map((id) => [id, !off.includes(id)]));
const enabledWith = (off) => [...effectiveModules(install(off), new Map(), MODULE_MANIFESTS)];
const decls = scopeDeclarations(MODULE_MANIFESTS);

const jmapModule = {
	moduleId: "calendar",
	promptFragment: null,
	descriptors: [
		{
			name: "calendars",
			surfaces: ["jmap_capability"],
			description: "Test capability",
			inputSchema: {},
			effect: "none",
			jmap: { urn: "urn:test:calendars", capability: { maxCalendars: 1 } },
		},
		{
			name: "Calendar/get",
			surfaces: ["jmap_method"],
			description: "Test method",
			inputSchema: {},
			effect: "read",
			jmap: { method: "Calendar/get" },
		},
	],
};

test("mcp_tool lists Calendar's eight tools with Calendar on and none with Calendar off", () => {
	assert.deepEqual(names(listCapabilities("mcp_tool", enabledWith([]))), CALENDAR_TOOLS);
	assert.deepEqual(names(listCapabilities("mcp_tool", enabledWith(["calendar"]))), []);
	assert.deepEqual(
		names(listCapabilities("mcp_tool", enabledWith(["booking", "templates", "import"]))),
		CALENDAR_TOOLS,
	);
});

test("assistant_tool lists Calendar's eight tools with Calendar on and none with Calendar off", () => {
	assert.deepEqual(names(listCapabilities("assistant_tool", enabledWith([]))), CALENDAR_TOOLS);
	assert.deepEqual(names(listCapabilities("assistant_tool", enabledWith(["calendar"]))), []);
});

test("jmap_capability and jmap_method list a test-only module's declarations only while it is on", () => {
	const all = [...MODULE_CAPABILITIES, jmapModule];
	assert.deepEqual(names(selectCapabilities(all, "jmap_capability", ["calendar"])), ["calendars"]);
	assert.deepEqual(names(selectCapabilities(all, "jmap_method", ["calendar"])), ["Calendar/get"]);
	assert.deepEqual(names(selectCapabilities(all, "jmap_capability", ["booking"])), []);
	assert.deepEqual(names(selectCapabilities(all, "jmap_method", [])), []);
	assert.deepEqual(names(listCapabilities("jmap_capability", ALL)), []);
	assert.deepEqual(names(listCapabilities("jmap_method", ALL)), []);
});

test("webhook_event lists the four module events, three with Booking off and none with Calendar off", () => {
	assert.deepEqual(names(listCapabilities("webhook_event", enabledWith([]))), [
		"eventCreated",
		"eventUpdated",
		"eventDeleted",
		"appointmentCreated",
	]);
	assert.deepEqual(names(listCapabilities("webhook_event", enabledWith(["booking"]))), [
		"eventCreated",
		"eventUpdated",
		"eventDeleted",
	]);
	assert.deepEqual(names(listCapabilities("webhook_event", enabledWith(["calendar"]))), []);
});

test("search lists the events provider only with Calendar on", () => {
	const events = listCapabilities("search", enabledWith([])).map((item) => item.descriptor.search.section);
	assert.deepEqual(events, ["events"]);
	assert.deepEqual(listCapabilities("search", enabledWith(["calendar"])), []);
});

test("every module's scopes stay registered whether the module is on or off", () => {
	assert.deepEqual(allKeyScopes(decls, "mcp"), [
		"mcp:read",
		"mcp:draft",
		"mcp:organize",
		"mcp:request-send",
		"mcp:calendar-read",
		"mcp:calendar-write",
	]);
	assert.deepEqual(allKeyScopes(decls, "api"), ["send", "read", "jmap", "calendar:read", "calendar:write"]);
	assert.deepEqual(CORE_MCP_SCOPES, ["mcp:read", "mcp:draft", "mcp:organize", "mcp:request-send"]);
	assert.deepEqual(CORE_API_KEY_SCOPES, ["send", "read", "jmap"]);
	assert.equal(scopeOwner(decls, "mcp", "mcp:calendar-read"), "calendar");
	assert.equal(scopeOwner(decls, "api", "calendar:write"), "calendar");
	assert.equal(scopeOwner(decls, "mcp", "mcp:read"), null);
	assert.equal(scopeOwner(decls, "api", "mcp:calendar-read"), null);
});

test("a scope is available when it is core or its module is on", () => {
	const on = enabledWith([]);
	const off = enabledWith(["calendar"]);
	for (const scope of CORE_MCP_SCOPES) assert.ok(isScopeAvailable(decls, "mcp", scope, off), scope);
	for (const scope of CORE_API_KEY_SCOPES) assert.ok(isScopeAvailable(decls, "api", scope, off), scope);
	assert.ok(isScopeAvailable(decls, "mcp", "mcp:calendar-read", on));
	assert.ok(!isScopeAvailable(decls, "mcp", "mcp:calendar-read", off));
	assert.ok(isScopeAvailable(decls, "api", "calendar:read", on));
	assert.ok(!isScopeAvailable(decls, "api", "calendar:write", off));
});

test("calendar scopes need no mailbox and every other scope does", () => {
	assert.equal(scopesNeedMailbox(decls, "mcp", ["mcp:calendar-read"]), false);
	assert.equal(scopesNeedMailbox(decls, "mcp", ["mcp:calendar-write"]), false);
	assert.equal(scopesNeedMailbox(decls, "mcp", ["mcp:read"]), true);
	assert.equal(scopesNeedMailbox(decls, "api", ["calendar:read"]), false);
	assert.equal(scopesNeedMailbox(decls, "api", ["read"]), true);
	assert.equal(scopesNeedMailbox(decls, "api", ["jmap"]), true);
	assert.equal(scopesNeedMailbox(decls, "mcp", ["mcp:calendar-read", "mcp:calendar-write"]), false);
	assert.equal(scopesNeedMailbox(decls, "mcp", ["mcp:calendar-read", "mcp:read"]), true);
	assert.equal(scopesNeedMailbox(decls, "api", ["calendar:read", "calendar:write"]), false);
	const bound = [{ id: "calendar", name: "Calendar", mcp: [{ scope: "mcp:x", mailboxBound: true }], api: [] }];
	assert.equal(scopesNeedMailbox(bound, "mcp", ["mcp:x"]), true);
});

test("creating an MCP key with a disabled module's scope is refused with MODULE_DISABLED", () => {
	const off = enabledWith(["calendar"]);
	for (const scopes of [["mcp:calendar-read"], ["mcp:read", "mcp:calendar-write"]]) {
		const refusal = scopeRefusal(decls, "mcp", scopes, off);
		assert.equal(refusal.status, 400, scopes.join());
		assert.equal(refusal.body.code, "MODULE_DISABLED");
		assert.equal(refusal.body.moduleId, "calendar");
		assert.equal(refusal.body.error, "Calendar is turned off");
	}
	assert.equal(scopeRefusal(decls, "mcp", ["mcp:read", "mcp:draft"], off), null);
	assert.equal(scopeRefusal(decls, "mcp", ["mcp:read", "mcp:calendar-write"], enabledWith([])), null);
});

test("creating an API key with a disabled module's scope is refused with MODULE_DISABLED", () => {
	const off = enabledWith(["calendar"]);
	const refusal = scopeRefusal(decls, "api", ["read", "calendar:read"], off);
	assert.equal(refusal.status, 400);
	assert.equal(refusal.body.code, "MODULE_DISABLED");
	assert.equal(scopeRefusal(decls, "api", ["read", "send", "jmap"], off), null);
	assert.equal(scopeRefusal(decls, "api", ["calendar:read"], enabledWith([])), null);
});

test("a user restricted from Calendar gets the same refusal while the install has it on", () => {
	const restricted = [...effectiveModules(install(), new Map([["calendar", false]]), MODULE_MANIFESTS)];
	assert.equal(scopeRefusal(decls, "mcp", ["mcp:calendar-read"], restricted).body.code, "MODULE_DISABLED");
	assert.equal(scopeRefusal(decls, "mcp", ["mcp:calendar-read"], enabledWith([])), null);
});

test("MCP keys hold the grants of their scopes, and tools need all of the grants they declare", () => {
	assert.deepEqual(grantsForMcpScopes(MODULE_MANIFESTS, ["mcp:read"]), []);
	assert.deepEqual(grantsForMcpScopes(MODULE_MANIFESTS, ["mcp:read", "mcp:calendar-read"]), ["calendar.read"]);
	const write = grantsForMcpScopes(MODULE_MANIFESTS, ["mcp:calendar-write", "mcp:calendar-read"]);
	assert.deepEqual([...write].sort(), ["calendar.read", "calendar.write"]);
	const listed = listCapabilities("mcp_tool", enabledWith([]));
	assert.deepEqual(names(mcpToolsFor(listed, ["calendar.read"])), READ_TOOLS);
	assert.deepEqual(names(mcpToolsFor(listed, write)), CALENDAR_TOOLS);
	assert.deepEqual(names(mcpToolsFor(listed, [])), []);
	assert.deepEqual(names(mcpToolsFor(listed, ["calendar.write"])), ["create_event", "update_events", "delete_events"]);
});

test("client scope data matches the manifests", () => {
	const fromClient = clientScopeDeclarations(CLIENT_MODULES);
	assert.deepEqual(fromClient, decls);
});

const CORE_MCP_OPTIONS = CORE_MCP_SCOPES.map((value) => ({ value, label: `core ${value}`, description: "core" }));
const CORE_API_OPTIONS = CORE_API_KEY_SCOPES.map((value) => ({ value, label: `core ${value}`, description: "core" }));
const optionPairs = (options) => options.map((option) => [option.value, option.label, option.description]);

test("key form options are the core options followed by the declared options of the modules that are on", () => {
	const on = enabledWith([]);
	assert.deepEqual(optionPairs(keyScopeOptions("mcp", CORE_MCP_OPTIONS, CLIENT_MODULES, on)), [
		...optionPairs(CORE_MCP_OPTIONS),
		["mcp:calendar-read", "Read calendar", "List, search, and inspect events and free time."],
		["mcp:calendar-write", "Manage calendar", "Create, update, and delete events."],
	]);
	assert.deepEqual(optionPairs(keyScopeOptions("api", CORE_API_OPTIONS, CLIENT_MODULES, on)), [
		...optionPairs(CORE_API_OPTIONS),
		["calendar:read", "Read calendar", "Read your calendar events through the API."],
		["calendar:write", "Manage calendar", "Create, update, and delete your calendar events through the API."],
	]);
});

test("key form options drop a module's scopes while it is off and keep the core ones", () => {
	for (const off of [enabledWith(["calendar"]), []]) {
		assert.deepEqual(keyScopeOptions("mcp", CORE_MCP_OPTIONS, CLIENT_MODULES, off), CORE_MCP_OPTIONS);
		assert.deepEqual(keyScopeOptions("api", CORE_API_OPTIONS, CLIENT_MODULES, off), CORE_API_OPTIONS);
	}
	const withoutBooking = keyScopeOptions("api", CORE_API_OPTIONS, CLIENT_MODULES, enabledWith(["booking"]));
	assert.equal(withoutBooking.length, CORE_API_OPTIONS.length + 2);
});

test("key form options follow whatever the client data declares, in registry order", () => {
	const modules = [
		{
			id: "calendar",
			name: "Calendar",
			keyScopes: { mcp: [], api: [{ scope: "a:one", label: "One", description: "1" }] },
		},
		{ id: "booking", name: "Booking" },
		{
			id: "templates",
			name: "Templates",
			keyScopes: { mcp: [{ scope: "mcp:t", mailboxBound: false, label: "T", description: "t" }], api: [] },
		},
	];
	assert.deepEqual(keyScopeOptions("api", [], modules, ["calendar", "booking", "templates"]), [
		{ value: "a:one", label: "One", description: "1" },
	]);
	assert.deepEqual(keyScopeOptions("mcp", [], modules, ["templates"]), [
		{ value: "mcp:t", label: "T", description: "t" },
	]);
	assert.deepEqual(keyScopeOptions("mcp", [], modules, ["calendar"]), []);
});

test("every client key scope has main's form text and matches a manifest scope", () => {
	for (const slice of CLIENT_MODULES) {
		const manifest = MODULE_MANIFESTS.find((item) => item.id === slice.id);
		for (const item of slice.keyScopes?.mcp ?? []) {
			assert.ok(item.label && item.description, item.scope);
			assert.ok(
				manifest.mcpScopes.some((scope) => scope.scope === item.scope),
				item.scope,
			);
		}
		for (const item of slice.keyScopes?.api ?? []) {
			assert.ok(item.label && item.description, item.scope);
			assert.ok(
				manifest.apiKeyScopes.some((scope) => scope.scope === item.scope),
				item.scope,
			);
		}
	}
});
