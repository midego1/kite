import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	MODULE_CAPABILITIES,
	MODULE_MANIFESTS,
	CORE_COMMANDS,
	listCommands,
	selectPromptFragments,
	buildCallContext,
	selectCapabilities,
	agentToday,
	OPEN_PAGE_TOOL,
	navigateCommands,
	openPageSchema,
	openPageDescription,
	runOpenPage,
	collectToolRefs,
	withResolvedRefs,
	agentToolLabel,
	activeAgentToolLabel,
	agentToolLinks,
	toJsonOutput,
	withCalendarToolRefs,
} = await bundleModules("kite-agent-chat-tools-", [
	["MODULE_CAPABILITIES", "src/lib/modules/capability-registry.ts"],
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
	["CORE_COMMANDS", "src/lib/modules/core-commands.ts"],
	["listCommands", "src/components/shortcuts/command-palette-utils.ts"],
	["selectPromptFragments, buildCallContext, selectCapabilities", "src/lib/modules/capability-utils.ts"],
	["agentToday", "src/lib/agent/time.ts"],
	[
		"OPEN_PAGE_TOOL, navigateCommands, openPageSchema, openPageDescription, runOpenPage, collectToolRefs, withResolvedRefs",
		"src/lib/agent/chat-tools-utils.ts",
	],
	["agentToolLabel, activeAgentToolLabel", "src/components/agent/utils.ts"],
	["agentToolLinks", "src/components/agent/tool-links-utils.ts"],
	["toJsonOutput, withCalendarToolRefs", "src/lib/calendar/tool-ref-utils.ts"],
]);

const ALL = ["calendar", "booking", "templates", "import", "finance"];
const calendarFragment = MODULE_CAPABILITIES.find((entry) => entry.moduleId === "calendar").promptFragment;
const commandsFor = (enabled) => navigateCommands(listCommands({ enabled }));
const enumFor = (enabled) => openPageSchema(commandsFor(enabled)).properties.command.enum;

test("prompt fragments of enabled modules fill {timeZone} and {today}; off modules add nothing", () => {
	assert.ok(calendarFragment.includes("{timeZone}") && calendarFragment.includes("{today}"));
	const on = selectPromptFragments(MODULE_CAPABILITIES, ALL, { timeZone: "Europe/Amsterdam", today: "2026-11-03" });
	assert.equal(on.length, 1);
	assert.ok(on[0].includes("Europe/Amsterdam") && on[0].includes("2026-11-03"));
	assert.ok(!/\{timeZone\}|\{today\}/.test(on[0]));
	assert.deepEqual(
		selectPromptFragments(MODULE_CAPABILITIES, ["booking", "templates", "import"], { timeZone: "UTC", today: "x" }),
		[],
	);
});

test("agentToday is the calendar date in the user's time zone", () => {
	const moment = new Date("2026-11-03T23:30:00Z");
	assert.equal(agentToday("UTC", moment), "2026-11-03");
	assert.equal(agentToday("Asia/Tokyo", moment), "2026-11-04");
	assert.equal(agentToday("Not/AZone", moment), "2026-11-03");
});

test("a chat call context carries the viewer, the trigger and the grants of the enabled modules only", () => {
	const viewer = { userId: "u1", role: "user", isPrimaryAdmin: false };
	const ctx = buildCallContext({
		trigger: "chat",
		viewer,
		timeZone: "Europe/Paris",
		mailboxIds: ["mb1"],
		enabled: ALL,
		manifests: MODULE_MANIFESTS,
	});
	assert.equal(ctx.trigger, "chat");
	assert.deepEqual(ctx.viewer, viewer);
	assert.equal(ctx.timeZone, "Europe/Paris");
	assert.deepEqual(ctx.mailboxIds, ["mb1"]);
	assert.ok(ctx.requestId);
	for (const grant of [
		"calendar.read",
		"calendar.write",
		"booking.read",
		"import.run",
		"finance.read",
		"finance.write",
	])
		assert.ok(ctx.grants.includes(grant), grant);
	assert.deepEqual(JSON.parse(JSON.stringify(ctx)), ctx);
	const calendarOff = buildCallContext({
		trigger: "chat",
		viewer,
		timeZone: "UTC",
		enabled: ["templates", "import"],
		manifests: MODULE_MANIFESTS,
	});
	assert.ok(!calendarOff.grants.some((grant) => grant.startsWith("calendar.") || grant.startsWith("booking.")));
	assert.deepEqual(buildCallContext({ trigger: "mcp", viewer: null, timeZone: "UTC" }).grants, []);
});

test("a call context honours explicit grants, ids and locale, and the api trigger holds a session's grants", () => {
	const viewer = { userId: "u1", role: "user", isPrimaryAdmin: false };
	const explicit = buildCallContext({
		trigger: "mcp",
		viewer,
		timeZone: "UTC",
		grants: ["calendar.read"],
		requestId: "req-1",
		locale: "nl",
	});
	assert.deepEqual(explicit.grants, ["calendar.read"]);
	assert.equal(explicit.requestId, "req-1");
	assert.equal(explicit.locale, "nl");
	assert.ok(!("mailboxIds" in explicit));
	const api = buildCallContext({
		trigger: "api",
		viewer,
		timeZone: "UTC",
		enabled: ["calendar"],
		manifests: MODULE_MANIFESTS,
	});
	assert.ok(api.grants.includes("calendar.read") && !api.grants.includes("import.run"));
	assert.deepEqual(buildCallContext({ trigger: "chat", viewer, timeZone: "UTC" }).grants, []);
	assert.deepEqual(
		selectCapabilities(MODULE_CAPABILITIES, "assistant_tool", ["templates", "import"]).map((entry) => entry.moduleId),
		[],
	);
	assert.ok(selectCapabilities(MODULE_CAPABILITIES, "assistant_tool", ["calendar"]).length >= 8);
	assert.deepEqual(
		selectPromptFragments([{ moduleId: "import", descriptors: [] }], ["import"], { timeZone: "UTC", today: "x" }),
		[],
	);
});

test("open_page lists only navigate commands with route targets that are enabled", () => {
	const everything = enumFor(ALL);
	for (const id of [
		"calendar.open",
		"calendar.go_to_date",
		"booking.open",
		"booking.open_event_type",
		"import.open",
		"finance.open",
		"mail.export",
		"nav-inbox",
		"nav-settings",
	])
		assert.ok(everything.includes(id), id);
	for (const id of ["compose", "show-help", "calendar.new_event", "booking.copy_link"])
		assert.ok(!everything.includes(id), `${id} is not a navigation route`);
	const calendarOff = enumFor(["templates", "import"]);
	assert.ok(!calendarOff.some((id) => id.startsWith("calendar.") || id.startsWith("booking.")));
	assert.ok(calendarOff.includes("import.open") && calendarOff.includes("mail.export"));
	const bookingOff = enumFor(["calendar", "templates", "import"]);
	assert.ok(bookingOff.includes("calendar.open") && !bookingOff.some((id) => id.startsWith("booking.")));
	const importOff = enumFor(["calendar", "booking", "templates"]);
	assert.ok(!importOff.includes("import.open") && importOff.includes("mail.export"));
	assert.ok(!enumFor(["calendar", "booking", "templates", "import"]).includes("finance.open"));
	assert.deepEqual(
		everything.filter((id) => CORE_COMMANDS.some((c) => c.id === id)).sort(),
		CORE_COMMANDS.filter((c) => c.effect === "navigate" && c.target.type === "route")
			.map((c) => c.id)
			.sort(),
	);
});

test("the open_page schema is plain JSON that names the command and optional params", () => {
	const schema = openPageSchema(commandsFor(ALL));
	assert.equal(OPEN_PAGE_TOOL, "open_page");
	assert.equal(schema.type, "object");
	assert.deepEqual(schema.required, ["command"]);
	assert.equal(schema.properties.command.type, "string");
	assert.equal(schema.properties.params.type, "object");
	assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
	const text = openPageDescription(commandsFor(ALL));
	assert.ok(text.includes("calendar.go_to_date") && text.includes("date"));
	assert.ok(!openPageDescription(commandsFor(["templates"])).includes("calendar."));
});

test("open_page returns a same-origin link and nothing else", () => {
	const commands = commandsFor(ALL);
	assert.deepEqual(runOpenPage(commands, { command: "calendar.open" }), { href: "/calendar", label: "Open Calendar" });
	assert.deepEqual(runOpenPage(commands, { command: "calendar.go_to_date", params: { date: "2026-11-03" } }), {
		href: "/calendar?date=2026-11-03",
		label: "Go to a date in Calendar",
	});
	assert.equal(runOpenPage(commands, { command: "nav-inbox" }).href, "/inbox");
	assert.equal(
		runOpenPage(commands, { command: "booking.open_event_type", params: { id: "a b&c=d/../?x" } }).href,
		"/booking?event=a%20b%26c%3Dd%2F..%2F%3Fx",
	);
});

test("open_page refuses unknown and disabled ids, invalid params and arbitrary URLs", () => {
	const commands = commandsFor(ALL);
	for (const command of [
		"https://evil.example/x",
		"//evil.example",
		"no.such.command",
		"javascript:alert(1)",
		"",
		7,
		null,
	])
		assert.throws(() => runOpenPage(commands, { command }), /./, String(command));
	assert.throws(() => runOpenPage(commands, null), /./);
	assert.throws(() => runOpenPage(commands, "calendar.open"), /./);
	assert.throws(
		() => runOpenPage(commandsFor(["templates", "import"]), { command: "calendar.open" }),
		/not available/i,
	);
	assert.throws(() => runOpenPage(commands, { command: "calendar.go_to_date" }), /date/);
	assert.throws(() => runOpenPage(commands, { command: "calendar.go_to_date", params: { date: "tomorrow" } }), /date/);
	assert.throws(
		() =>
			runOpenPage(commands, { command: "calendar.go_to_date", params: { date: "2026-11-03", href: "//evil.example" } }),
		/href/,
	);
	assert.throws(
		() => runOpenPage(commands, { command: "calendar.open", params: { next: "https://evil.example" } }),
		/next/,
	);
	assert.throws(() => runOpenPage(commands, { command: "calendar.open", params: "x" }), /./);
	assert.throws(() => runOpenPage(commands, { command: "compose" }), /not available/i);
});

test("tool results name their record refs and the chat attaches resolved ones", () => {
	assert.deepEqual(collectToolRefs({ ref: { kind: "calendar:event", id: "e1" }, status: "created" }), [
		{ kind: "calendar:event", id: "e1" },
	]);
	assert.deepEqual(
		collectToolRefs({
			refs: [
				{ kind: "calendar:event", id: "e1" },
				{ kind: "calendar:event", id: "e2" },
			],
		}),
		[
			{ kind: "calendar:event", id: "e1" },
			{ kind: "calendar:event", id: "e2" },
		],
	);
	assert.deepEqual(collectToolRefs({ ref: { kind: 1, id: "e1" }, refs: "x" }), []);
	assert.deepEqual(collectToolRefs("text"), []);
	assert.deepEqual(collectToolRefs(null), []);
	assert.equal(
		collectToolRefs({ refs: Array.from({ length: 80 }, (_, i) => ({ kind: "mail:message", id: `m${i}` })) }).length,
		20,
	);
	const output = { ref: { kind: "calendar:event", id: "e1" }, status: "created" };
	const resolved = [
		{ kind: "calendar:event", id: "e1", href: "/calendar?date=2026-11-03&event=e1", label: "Team sync" },
	];
	assert.deepEqual(withResolvedRefs(output, resolved), { ...output, resolvedRefs: resolved });
	assert.deepEqual(withResolvedRefs(output, []), output);
	assert.equal(withResolvedRefs("plain", resolved), "plain");
});

test("module tools get labels from their names, and the calendar needs no entry in core", () => {
	const label = (name) => ({
		running: activeAgentToolLabel(name),
		completed: agentToolLabel(name, "used", "{}").label,
	});
	assert.deepEqual(label("get_schedule"), { running: "Getting schedule...", completed: "Got schedule" });
	assert.deepEqual(label("create_event"), { running: "Creating event...", completed: "Created event" });
	assert.deepEqual(label("find_free_time"), { running: "Finding free time...", completed: "Found free time" });
	assert.deepEqual(label("update_events"), { running: "Updating events...", completed: "Updated events" });
	assert.deepEqual(label("frobnicate_widgets"), {
		running: "Using frobnicate widgets...",
		completed: "Used frobnicate widgets",
	});
	assert.equal(activeAgentToolLabel("search_events"), "Searching events...");
	assert.equal(agentToolLabel("delete_events", "used", '{"status":"deleted"}').label, "Deleted events");
	assert.equal(
		agentToolLabel("open_page", "used", '{"href":"/calendar","label":"Open Calendar"}').label,
		"Prepared a link",
	);
	assert.equal(agentToolLabel("open_page", "running", "").label, "Preparing a link...");
});

test("the chat shows open_page results and resolved refs as links, and nothing else", () => {
	const page = {
		id: "a",
		role: "tool",
		toolName: "open_page",
		toolState: "used",
		content: '{"href":"/calendar","label":"Open Calendar"}',
	};
	assert.deepEqual(agentToolLinks(page), [{ href: "/calendar", label: "Open Calendar" }]);
	for (const href of ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "calendar"])
		assert.deepEqual(agentToolLinks({ ...page, content: JSON.stringify({ href, label: "x" }) }), [], href);
	assert.deepEqual(agentToolLinks({ ...page, toolState: "failed", content: "Command is not available" }), []);
	assert.deepEqual(agentToolLinks({ ...page, toolName: "get_email" }), []);
	const created = {
		id: "b",
		role: "tool",
		toolName: "create_event",
		toolState: "used",
		content: JSON.stringify({
			ref: { kind: "calendar:event", id: "e1" },
			resolvedRefs: [
				{ kind: "calendar:event", id: "e1", href: "/calendar?date=2026-11-03&event=e1", label: "Team sync" },
				{ kind: "calendar:event", id: "e2", unavailable: true, label: "Calendar event" },
				{ kind: "calendar:event", id: "e3", href: "https://evil.example", label: "Bad" },
			],
		}),
	};
	assert.deepEqual(agentToolLinks(created), [
		{ href: "/calendar?date=2026-11-03&event=e1", label: "Team sync" },
		{ href: null, label: "Calendar event" },
		{ href: null, label: "Bad" },
	]);
});

test("calendar tool results become plain JSON and name the events they touched", () => {
	const row = { id: "evt_1", title: "Team sync", startsAt: new Date("2026-11-03T10:00:00Z"), note: undefined };
	assert.deepEqual(toJsonOutput({ event: row }), {
		event: { id: "evt_1", title: "Team sync", startsAt: "2026-11-03T10:00:00.000Z" },
	});
	assert.equal(toJsonOutput(undefined), null);
	assert.deepEqual(withCalendarToolRefs("create_event", { eventId: "evt_1", status: "created" }), {
		eventId: "evt_1",
		status: "created",
		ref: { kind: "calendar:event", id: "evt_1" },
	});
	assert.deepEqual(withCalendarToolRefs("update_events", { eventIds: ["evt_1", "evt_2"], status: "updated" }).refs, [
		{ kind: "calendar:event", id: "evt_1" },
		{ kind: "calendar:event", id: "evt_2" },
	]);
	assert.deepEqual(withCalendarToolRefs("get_event", { event: { id: "evt_1", title: "x" } }).ref, {
		kind: "calendar:event",
		id: "evt_1",
	});
	for (const [name, output] of [
		["get_schedule", { events: [] }],
		["delete_events", { eventIds: ["evt_1"], status: "deleted" }],
		["create_event", { status: "created" }],
		["get_event", { event: null }],
		["create_event", "text"],
	])
		assert.deepEqual(withCalendarToolRefs(name, output), output, name);
});
