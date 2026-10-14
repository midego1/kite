import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	MODULE_MANIFESTS,
	MODULE_IDS,
	CLIENT_MODULES,
	CLIENT_MODULE_IDS,
	CORE_COMMANDS,
	CORE_SHORTCUTS,
	listCommands,
	listShortcutBindings,
	commandParamFields,
	validateCommandParams,
	fillCommandHref,
	runCommand,
	handlersByCommandId,
	filterCommands,
	groupCommandsByCategory,
	orderCommandsByGroup,
	calendarDateFromParam,
	findEventForUrl,
	expandCalendarEvents,
} = await bundleModules("kite-module-commands-", [
	["MODULE_MANIFESTS, MODULE_IDS", "src/lib/modules/registry.ts"],
	["CLIENT_MODULES", "src/lib/modules/client-data/index.ts"],
	["MODULE_IDS as CLIENT_MODULE_IDS", "src/lib/modules/client-data/module-ids.ts"],
	["CORE_COMMANDS, CORE_SHORTCUTS", "src/lib/modules/core-commands.ts"],
	[
		"listCommands, listShortcutBindings, commandParamFields, validateCommandParams, fillCommandHref, runCommand, handlersByCommandId, filterCommands, groupCommandsByCategory, orderCommandsByGroup",
		"src/components/shortcuts/command-palette-utils.ts",
	],
	["calendarDateFromParam, findEventForUrl, expandCalendarEvents", "src/app/(calendar)/calendar/utils.ts"],
]);

const ALL = ["calendar", "booking", "templates", "import", "finance"];
const ids = (commands) => commands.map((command) => command.id);
const moduleCommands = MODULE_MANIFESTS.flatMap((manifest) => manifest.commands);
const everyCommand = [...CORE_COMMANDS, ...moduleCommands];
const byId = (id) => everyCommand.find((command) => command.id === id);
const clientHandlers = (commands) => commands.filter((command) => command.target.type === "client").map((c) => c.id);
const CORE_CLIENT = ["compose", "show-help"];

test("every command declares the designed fields", () => {
	const effects = ["navigate", "read", "fill", "create", "update", "delete"];
	const actions = ["open_view", "apply_filter", "open_dialog", "fill_form", "invoke"];
	for (const command of everyCommand) {
		for (const key of ["id", "label", "description", "group"])
			assert.ok(typeof command[key] === "string" && command[key].trim(), `${command.id} ${key}`);
		assert.ok(effects.includes(command.effect), `${command.id} effect`);
		if (command.target.type === "route") assert.ok(command.target.href.startsWith("/"), command.id);
		else {
			assert.equal(command.target.type, "client", command.id);
			assert.ok(actions.includes(command.target.action), `${command.id} action`);
			assert.ok(command.target.handler, `${command.id} handler`);
		}
		if (command.params !== undefined) {
			assert.equal(command.params.type, "object", `${command.id} params`);
			assert.equal(typeof command.params.properties, "object", `${command.id} params.properties`);
		}
		assert.deepEqual(JSON.parse(JSON.stringify(command)), command, `${command.id} survives JSON`);
	}
	for (const command of CORE_COMMANDS) assert.equal(command.moduleId, "core", command.id);
	for (const manifest of MODULE_MANIFESTS)
		for (const command of manifest.commands) assert.equal(command.moduleId, manifest.id, command.id);
	assert.equal(new Set(ids(everyCommand)).size, everyCommand.length, "ids are unique");
	assert.ok(Object.hasOwn(byId("calendar.go_to_date").params.properties, "date"));
	assert.ok(Object.hasOwn(byId("booking.open_event_type").params.properties, "id"));
});

test("the spec's module commands exist with the right targets and effects", () => {
	assert.deepEqual(ids(moduleCommands), [
		"calendar.open",
		"calendar.go_to_date",
		"calendar.new_event",
		"booking.open",
		"booking.open_event_type",
		"booking.copy_link",
		"import.open",
		"finance.open",
	]);
	assert.deepEqual(byId("calendar.new_event").target, { type: "client", action: "open_dialog", handler: "newEvent" });
	assert.deepEqual(byId("booking.copy_link").target, { type: "client", action: "invoke", handler: "copyLink" });
	assert.equal(byId("import.open").target.href, "/settings/import");
	assert.equal(byId("finance.open").target.href, "/finance");
	assert.equal(byId("mail.export").target.href, "/settings/export");
	assert.equal(byId("mail.export").moduleId, "core");
	assert.equal(MODULE_MANIFESTS.find((manifest) => manifest.id === "templates").commands.length, 0);
});

test("built-in commands keep the ids, titles and shortcuts they had in shortcuts-context", () => {
	const builtins = [
		["compose", "Compose new message", "c"],
		["nav-inbox", "Go to Inbox", "g i"],
		["nav-starred", "Go to Starred", "g s"],
		["nav-snoozed", "Go to Snoozed", "g z"],
		["nav-sent", "Go to Sent", "g t"],
		["nav-drafts", "Go to Drafts", "g d"],
		["nav-archived", "Go to Archived", "g a"],
		["nav-spam", "Go to Spam", "g !"],
		["nav-trash", "Go to Trash", "g x"],
		["settings-account", "Account Settings", undefined],
		["show-help", "Keyboard Shortcuts Cheat Sheet", "?"],
	];
	for (const [id, label, shortcut] of builtins) {
		const command = CORE_COMMANDS.find((item) => item.id === id);
		assert.ok(command, id);
		assert.equal(command.label, label, id);
		assert.equal(command.shortcut, shortcut, id);
	}
	const routes = Object.fromEntries(
		CORE_COMMANDS.filter((item) => item.target.type === "route").map((item) => [item.id, item.target.href]),
	);
	assert.deepEqual(routes, {
		"nav-inbox": "/inbox",
		"nav-starred": "/starred",
		"nav-snoozed": "/snoozed",
		"nav-sent": "/sent",
		"nav-drafts": "/drafts",
		"nav-archived": "/archived",
		"nav-spam": "/spam",
		"nav-trash": "/trash",
		"nav-for-you": "/for-you",
		"nav-activity": "/kite-activity",
		"nav-settings": "/settings",
		"settings-account": "/settings/account",
		"mail.export": "/settings/export",
	});
	assert.deepEqual(clientHandlers(CORE_COMMANDS), CORE_CLIENT);
	assert.ok(byId("compose").keywords.includes("Compose Email"));
});

test("the shortcut cheat sheet lists the same keys and labels as before", () => {
	assert.deepEqual(
		CORE_SHORTCUTS.map((item) => [item.key, item.label, item.category, item.modifiers]),
		[
			["k", "Command Palette", "General", ["meta", "ctrl"]],
			["?", "Shortcuts Cheat Sheet", "General", undefined],
			["c", "Compose Email", "Composing", undefined],
			["/", "Search Mail", "Navigation", undefined],
			["g i", "Go to Inbox", "Navigation", undefined],
			["g s", "Go to Starred", "Navigation", undefined],
			["g z", "Go to Snoozed", "Navigation", undefined],
			["g t", "Go to Sent", "Navigation", undefined],
			["g d", "Go to Drafts", "Navigation", undefined],
			["g a", "Go to Archived", "Navigation", undefined],
			["g !", "Go to Spam", "Navigation", undefined],
			["g x", "Go to Trash", "Navigation", undefined],
			["escape", "Dismiss Modal / Clear Focus", "General", undefined],
		],
	);
	for (const shortcut of CORE_SHORTCUTS) if ("commandId" in shortcut) assert.ok(byId(shortcut.commandId), shortcut.key);
});

test("with every module on the list holds the core and module navigation commands", () => {
	const listed = ids(listCommands({ enabled: ALL, handlers: [...CORE_CLIENT] }));
	for (const id of [
		"nav-inbox",
		"nav-sent",
		"nav-drafts",
		"nav-starred",
		"nav-snoozed",
		"nav-archived",
		"nav-spam",
		"nav-trash",
		"nav-for-you",
		"nav-activity",
		"nav-settings",
		"mail.export",
		"compose",
		"calendar.open",
		"calendar.go_to_date",
		"booking.open",
		"booking.open_event_type",
		"import.open",
		"finance.open",
	])
		assert.ok(listed.includes(id), id);
	assert.deepEqual(
		listed.filter((id) => id.includes(".") && !id.startsWith("mail.")),
		["calendar.open", "calendar.go_to_date", "booking.open", "booking.open_event_type", "import.open", "finance.open"],
	);
});

test("a client command that no handler serves is not listed", () => {
	const none = ids(listCommands({ enabled: ALL, handlers: [] }));
	for (const id of ["compose", "show-help", "calendar.new_event", "booking.copy_link"])
		assert.ok(!none.includes(id), id);
	const some = ids(listCommands({ enabled: ALL, handlers: new Set(["booking.copy_link"]) }));
	assert.ok(some.includes("booking.copy_link"));
	assert.ok(!some.includes("calendar.new_event"));
	assert.ok(ids(listCommands({ enabled: ALL })).every((id) => !clientHandlers(everyCommand).includes(id)));
});

test("a disabled module's commands are absent even when its handler was registered earlier", () => {
	const handlers = [...CORE_CLIENT, "calendar.new_event", "booking.copy_link"];
	const off = (enabled) => ids(listCommands({ enabled, handlers }));
	const noCalendar = off(["templates", "import"]);
	assert.deepEqual(
		noCalendar.filter((id) => id.startsWith("calendar.") || id.startsWith("booking.")),
		[],
	);
	assert.ok(noCalendar.includes("import.open"));
	const noImport = off(["calendar", "booking", "templates"]);
	assert.ok(!noImport.includes("import.open"));
	assert.ok(noImport.includes("mail.export"), "Export stays with Import off");
	assert.ok(noImport.includes("calendar.new_event"));
	const bookingOnly = off(["calendar", "templates", "import"]);
	assert.ok(!bookingOnly.some((id) => id.startsWith("booking.")));
	const nothing = off([]);
	assert.ok(nothing.includes("mail.export") && nothing.includes("nav-inbox") && nothing.includes("compose"));
	assert.ok(!nothing.some((id) => /^(calendar|booking|import|finance)\./.test(id)));
	assert.ok(!off(["calendar", "booking", "templates", "import"]).includes("finance.open"));
	assert.deepEqual(ids(listCommands({ enabled: undefined, handlers })), ids(listCommands({ enabled: ALL, handlers })));
});

test("listing follows the registry order, core first", () => {
	const listed = listCommands({ enabled: ALL, handlers: [...CORE_CLIENT, "calendar.new_event", "booking.copy_link"] });
	assert.deepEqual(
		listed.slice(0, CORE_COMMANDS.length).map((command) => command.id),
		ids(CORE_COMMANDS),
	);
	assert.deepEqual(ids(listed.slice(CORE_COMMANDS.length)), ids(moduleCommands));
});

test("shortcut bindings follow the same filter, so a disabled module's shortcut does nothing", () => {
	const custom = [
		{
			id: "x.open",
			moduleId: "calendar",
			label: "Open X",
			description: "d",
			group: "Navigation",
			target: { type: "route", href: "/x" },
			effect: "navigate",
			shortcut: "g c",
		},
	];
	const withModule = listShortcutBindings(
		listCommands({ enabled: ALL, handlers: CORE_CLIENT, modules: [{ id: "calendar", commands: custom }] }),
	);
	assert.deepEqual(
		withModule.find((binding) => binding.key === "g c"),
		{ key: "g c", label: "Open X", category: "Navigation", commandId: "x.open" },
	);
	const without = listShortcutBindings(
		listCommands({ enabled: ["booking"], handlers: CORE_CLIENT, modules: [{ id: "calendar", commands: custom }] }),
	);
	assert.equal(
		without.find((binding) => binding.key === "g c"),
		undefined,
	);
	assert.deepEqual(
		without.map((binding) => binding.key),
		CORE_SHORTCUTS.map((shortcut) => shortcut.key),
	);
});

test("a core shortcut for a command that is not listed is left out, chrome shortcuts stay", () => {
	const bindings = listShortcutBindings(listCommands({ enabled: [], handlers: [] }));
	const keys = bindings.map((binding) => binding.key);
	assert.ok(!keys.includes("c"), "compose has no handler");
	assert.ok(keys.includes("g i") && keys.includes("k") && keys.includes("?") && keys.includes("escape"));
	assert.equal(bindings.find((binding) => binding.key === "k").chrome, "togglePalette");
});

test("params fields come from the schema", () => {
	assert.deepEqual(commandParamFields(byId("calendar.go_to_date")), [
		{ name: "date", required: true, hint: "YYYY-MM-DD" },
	]);
	assert.deepEqual(commandParamFields(byId("booking.open_event_type")), [
		{ name: "id", required: true, hint: "Booking event type id" },
	]);
	assert.deepEqual(commandParamFields(byId("calendar.open")), []);
});

test("href templates are filled from validated params and encoded", () => {
	assert.deepEqual(fillCommandHref(byId("calendar.open")), { ok: true, href: "/calendar" });
	assert.deepEqual(fillCommandHref(byId("calendar.go_to_date"), { date: "2026-10-12" }), {
		ok: true,
		href: "/calendar?date=2026-10-12",
	});
	assert.deepEqual(fillCommandHref(byId("booking.open_event_type"), { id: "a b&c=1/../x?#" }), {
		ok: true,
		href: "/booking?event=a%20b%26c%3D1%2F..%2Fx%3F%23",
	});
});

test("href templating refuses unknown, missing and invalid params", () => {
	const refused = (command, values) => {
		const result = fillCommandHref(command, values);
		assert.equal(result.ok, false, JSON.stringify(values));
		assert.ok(result.error);
		return result.error;
	};
	refused(byId("calendar.go_to_date"), {});
	refused(byId("calendar.go_to_date"), { date: "" });
	refused(byId("calendar.go_to_date"), { date: "tomorrow" });
	refused(byId("calendar.go_to_date"), { date: "2026-10-12", extra: "1" });
	refused(byId("calendar.go_to_date"), { other: "2026-10-12" });
	refused(byId("calendar.go_to_date"), { date: 20261012 });
	refused(byId("booking.open_event_type"), { id: "x".repeat(161) });
	refused(byId("calendar.open"), { date: "2026-10-12" });
	assert.match(refused(byId("calendar.go_to_date"), { date: "2026-10-12", extra: "1" }), /extra/);
});

test("a template naming a placeholder the command does not declare is refused", () => {
	const base = { id: "t", moduleId: "core", label: "t", description: "t", group: "g", effect: "navigate" };
	assert.equal(fillCommandHref({ ...base, target: { type: "route", href: "/a?x={x}" } }).ok, false);
	const withParam = (href, value) =>
		fillCommandHref(
			{
				...base,
				params: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
				target: { type: "route", href },
			},
			{ x: value },
		);
	assert.equal(withParam("/a?x={x}", "1").ok, true);
	assert.equal(withParam("/a?y={y}", "1").ok, false);
	assert.deepEqual(withParam("/a/{x}/{x}", "v w"), { ok: true, href: "/a/v%20w/v%20w" });
	// a filled value can never turn the path into another origin
	assert.equal(withParam("{x}", "//evil.example").ok, false);
	assert.equal(withParam("{x}", "https://evil.example").ok, false);
	assert.equal(fillCommandHref({ ...base, target: { type: "client", action: "invoke", handler: "h" } }).ok, false);
});

test("validateCommandParams checks types, bounds, patterns, enums and required names", () => {
	const schema = {
		type: "object",
		properties: {
			name: { type: "string", minLength: 2, maxLength: 4 },
			kind: { type: "string", enum: ["a", "b"] },
			count: { type: "integer" },
			ratio: { type: "number" },
			flag: { type: "boolean" },
			free: {},
			bad: { type: "string", pattern: "(" },
		},
		required: ["name"],
	};
	assert.deepEqual(
		validateCommandParams(schema, { name: "ab", kind: "a", count: 2, ratio: 0.5, flag: false, free: 1 }),
		{
			ok: true,
			values: { name: "ab", kind: "a", count: 2, ratio: 0.5, flag: false, free: 1 },
		},
	);
	for (const values of [
		{},
		{ name: "a" },
		{ name: "abcde" },
		{ name: "ab", kind: "c" },
		{ name: "ab", count: 1.5 },
		{ name: "ab", count: "1" },
		{ name: "ab", ratio: Number.NaN },
		{ name: "ab", flag: "yes" },
		{ name: "ab", bad: "x" },
		{ name: "ab", nope: 1 },
		{ name: ["ab"] },
		null,
		"ab",
		[],
	])
		assert.equal(validateCommandParams(schema, values).ok, false, JSON.stringify(values));
	assert.deepEqual(validateCommandParams(undefined, undefined), { ok: true, values: {} });
	assert.equal(validateCommandParams(undefined, { a: "1" }).ok, false);
	assert.equal(validateCommandParams({ type: "object", properties: {} }, { a: "1" }).ok, false);
});

test("runCommand navigates a route command, calls a registered handler and reports the rest", async () => {
	const visited = [];
	const calls = [];
	const deps = {
		navigate: (href) => visited.push(href),
		handlers: {
			"calendar.new_event": (context) => calls.push(context),
			"booking.copy_link": async () => calls.push("copy"),
		},
	};
	assert.deepEqual(await runCommand(byId("nav-sent"), deps), { ok: true });
	assert.deepEqual(await runCommand(byId("calendar.go_to_date"), deps, { date: "2026-01-02" }), { ok: true });
	assert.deepEqual(visited, ["/sent", "/calendar?date=2026-01-02"]);
	assert.equal((await runCommand(byId("calendar.go_to_date"), deps, { date: "no" })).ok, false);
	assert.equal(visited.length, 2, "an invalid param navigates nowhere");
	assert.deepEqual(await runCommand(byId("calendar.new_event"), deps), { ok: true });
	assert.equal(typeof calls[0].navigate, "function");
	assert.deepEqual(await runCommand(byId("booking.copy_link"), deps), { ok: true });
	assert.equal(calls[1], "copy");
	const missing = await runCommand(byId("compose"), deps);
	assert.equal(missing.ok, false);
	const failing = await runCommand(byId("calendar.new_event"), {
		navigate() {},
		handlers: {
			"calendar.new_event": () => {
				throw new Error("boom");
			},
		},
	});
	assert.deepEqual(failing, { ok: false, error: "boom" });
});

test("a module chunk's handlers map onto command ids by the handler name each command declares", () => {
	const newEvent = () => {};
	const mapped = handlersByCommandId(moduleCommands, { newEvent, unrelated: () => {} });
	assert.deepEqual(Object.keys(mapped), ["calendar.new_event"]);
	assert.equal(mapped["calendar.new_event"], newEvent);
	assert.deepEqual(handlersByCommandId(moduleCommands, {}), {});
	assert.deepEqual(
		handlersByCommandId(
			CORE_COMMANDS.filter((command) => command.target.type === "route"),
			{ newEvent },
		),
		{},
	);
});

test("palette filtering matches title, subtitle, category and keywords, and groups by category", () => {
	const items = [
		{ id: "a", title: "Open Calendar", category: "Navigation", keywords: ["agenda"], perform() {} },
		{ id: "b", title: "Compose", subtitle: "draft editor", category: "Actions", perform() {} },
	];
	assert.equal(filterCommands(items, "  ").length, 2);
	assert.deepEqual(ids(filterCommands(items, "CALENDAR")), ["a"]);
	assert.deepEqual(ids(filterCommands(items, "agenda")), ["a"]);
	assert.deepEqual(ids(filterCommands(items, "editor")), ["b"]);
	assert.deepEqual(ids(filterCommands(items, "actions")), ["b"]);
	assert.deepEqual(filterCommands(items, "nothing"), []);
	assert.deepEqual(Object.keys(groupCommandsByCategory(items)), ["Navigation", "Actions"]);
});

test("the palette's display order is the grouped order, so arrow keys and Enter agree with the rows", () => {
	const items = [
		{ id: "compose", title: "Compose", category: "Actions", perform() {} },
		{ id: "inbox", title: "Go to Inbox", category: "Navigation", perform() {} },
		{ id: "account", title: "Account Settings", category: "Settings", perform() {} },
		{ id: "for-you", title: "Go to For you", category: "Navigation", perform() {} },
		{ id: "settings", title: "Go to Settings", category: "Settings", perform() {} },
		{ id: "calendar", title: "Open Calendar", category: "Navigation", perform() {} },
	];
	assert.deepEqual(ids(orderCommandsByGroup(items)), [
		"compose",
		"inbox",
		"for-you",
		"calendar",
		"account",
		"settings",
	]);
	const rows = Object.values(groupCommandsByCategory(items)).flat();
	assert.deepEqual(ids(orderCommandsByGroup(items)), ids(rows));
	assert.deepEqual(orderCommandsByGroup([]), []);
	assert.equal(orderCommandsByGroup(items)[3].id, "calendar");
});

test("the real palette list keeps one command per row after grouping", () => {
	const listed = listCommands({ enabled: ALL, handlers: [...CORE_CLIENT] });
	const items = listed.map((command) => ({
		id: command.id,
		title: command.label,
		category: command.group,
		perform() {},
	}));
	const ordered = orderCommandsByGroup(items);
	assert.equal(ordered.length, items.length);
	assert.deepEqual(ids(ordered).sort(), ids(items).sort());
	assert.notDeepEqual(ids(ordered), ids(items), "the raw list is not group-contiguous, which is why the order matters");
});

test("a series id resolves to the occurrence on the given day, then the first one, and an exact id still wins", () => {
	const weekly = {
		id: "series1",
		title: "Standup",
		startsAt: "2031-03-03T12:00:00.000Z",
		endsAt: "2031-03-03T13:00:00.000Z",
		repeat: "weekly",
		repeatDays: null,
		repeatUntil: null,
		excludedOccurrences: null,
		attendees: "[]",
	};
	const single = { ...weekly, id: "single1", repeat: "none" };
	const events = expandCalendarEvents(
		[weekly, single],
		new Date("2031-03-01T00:00:00.000Z"),
		new Date("2031-03-31T00:00:00.000Z"),
	);
	assert.ok(
		events.every((event) => event.id !== "series1"),
		"series occurrences carry @ ids",
	);
	const day = new Date("2031-03-17T12:00:00.000Z");
	assert.equal(findEventForUrl(events, "series1", day)?.startsAt, "2031-03-17T12:00:00.000Z");
	assert.equal(findEventForUrl(events, "series1", null)?.startsAt, "2031-03-03T12:00:00.000Z");
	assert.equal(
		findEventForUrl(events, "series1", new Date("2031-03-18T12:00:00.000Z"))?.startsAt,
		"2031-03-03T12:00:00.000Z",
	);
	assert.equal(findEventForUrl(events, "single1", day)?.id, "single1");
	assert.equal(findEventForUrl(events, events[1].id, day)?.id, events[1].id);
	assert.equal(findEventForUrl(events, "missing", day), undefined);
	assert.equal(findEventForUrl(events, "series", day), undefined, "a prefix of a series id is not that series");
});

test("a series id with no loaded occurrence falls back to the stored series row", () => {
	const row = (id, overrides) => ({
		id,
		title: "Standup",
		startsAt: "2031-03-03T12:00:00.000Z",
		endsAt: "2031-03-03T13:00:00.000Z",
		repeat: "weekly",
		repeatDays: null,
		repeatUntil: null,
		excludedOccurrences: null,
		attendees: "[]",
		...overrides,
	});
	const rangeStart = new Date("2031-06-01T00:00:00.000Z");
	const rangeEnd = new Date("2031-06-08T00:00:00.000Z");
	const excludedAll = row("truncated1", {
		repeatUntil: "2031-03-20T00:00:00.000Z",
		excludedOccurrences: JSON.stringify(["2031-03-03T12:00:00.000Z"]),
	});
	const ended = row("ended1", { repeat: "monthly", repeatUntil: "2031-03-04T00:00:00.000Z" });
	const visible = row("visible1");
	const stored = [excludedAll, ended, visible];
	const events = expandCalendarEvents(stored, rangeStart, rangeEnd);
	const day = new Date("2031-06-04T12:00:00.000Z");

	assert.equal(findEventForUrl(events, "truncated1", day), undefined, "without the stored rows nothing resolves");
	assert.equal(findEventForUrl(events, "truncated1", day, stored), excludedAll);
	assert.equal(findEventForUrl(events, "ended1", null, stored), ended);
	assert.equal(findEventForUrl(events, "missing", day, stored), undefined);
	assert.equal(
		findEventForUrl(events, "visible1", day, stored)?.id.startsWith("visible1@"),
		true,
		"a series with a loaded occurrence still opens that occurrence",
	);
	assert.equal(findEventForUrl(events, events[0].id, day, stored)?.id, events[0].id, "an exact occurrence id wins");
	assert.equal(findEventForUrl(events, "truncated", day, stored), undefined, "a prefix of a stored id is not a match");
});

test("the client slice equals what the manifests declare", () => {
	assert.deepEqual(CLIENT_MODULE_IDS, MODULE_IDS);
	assert.deepEqual(
		CLIENT_MODULES.map((slice) => slice.id),
		MODULE_MANIFESTS.map((manifest) => manifest.id),
	);
	for (const manifest of MODULE_MANIFESTS) {
		const slice = CLIENT_MODULES.find((item) => item.id === manifest.id);
		const { suggestionKinds, keyScopes, composerSlots, ...declared } = slice;
		assert.deepEqual(declared, {
			id: manifest.id,
			name: manifest.name,
			nav: manifest.nav,
			commands: manifest.commands,
		});
		assert.deepEqual(composerSlots ?? [], manifest.composerSlots);
		assert.deepEqual(suggestionKinds ?? [], manifest.id === "calendar" ? ["calendar_invite"] : []);
		assert.deepEqual(
			{
				mcp: (keyScopes?.mcp ?? []).map(({ scope, mailboxBound }) => ({ scope, mailboxBound })),
				api: (keyScopes?.api ?? []).map((item) => item.scope),
			},
			{
				mcp: manifest.mcpScopes.map(({ scope, mailboxBound }) => ({ scope, mailboxBound })),
				api: manifest.apiKeyScopes.map((item) => item.scope),
			},
		);
	}
});

test("a calendar date link names a real day only", () => {
	const day = calendarDateFromParam("2026-10-12");
	assert.ok(day instanceof Date && !Number.isNaN(day.getTime()));
	assert.equal(day.toISOString().slice(0, 10) >= "2026-10-11" && day.toISOString().slice(0, 10) <= "2026-10-12", true);
	for (const bad of [null, "", "tomorrow", "2026-13-01", "2026-02-30", "2026-1-1", "20261012"])
		assert.equal(calendarDateFromParam(bad), null, String(bad));
});
