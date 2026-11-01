import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	CLIENT_MODULES,
	NUMBERED_CATEGORIES,
	adjacentCategory,
	categoryForDigit,
	clampActive,
	commandHrefs,
	commandItems,
	commandPlacement,
	contactItem,
	countItems,
	digitOf,
	emptyMessage,
	groupItems,
	isTypingKey,
	listCategories,
	messageHref,
	messageItem,
	messageParty,
	moveActive,
	refKindType,
	sectionItems,
	settingsItems,
	shortcutKeys,
	contactLikePattern,
	normalizeContactQuery,
	parseContactSearchLimit,
	toContactSearchHit,
} = await bundleModules("kite-command-palette-", [
	["CLIENT_MODULES", "src/lib/modules/client-data/index.ts"],
	[
		"NUMBERED_CATEGORIES, adjacentCategory, categoryForDigit, clampActive, commandHrefs, commandItems, commandPlacement, contactItem, countItems, digitOf, emptyMessage, groupItems, isTypingKey, listCategories, messageHref, messageItem, messageParty, moveActive, refKindType, sectionItems, settingsItems, shortcutKeys",
		"src/components/shortcuts/palette-utils.ts",
	],
	[
		"contactLikePattern, normalizeContactQuery, parseContactSearchLimit, toContactSearchHit",
		"src/app/api/contacts/search/search-utils.ts",
	],
]);

const ALL = ["calendar", "booking", "templates", "import", "finance", "drive"];
const Icon = () => null;
const noop = () => {};
const command = (overrides) => ({
	id: "x",
	title: "X",
	category: "Navigation",
	perform: noop,
	...overrides,
});

test("the sidebar lists All, the core categories and a category per module that is on with commands or a search", () => {
	const commands = [
		command({ id: "calendar.open", moduleId: "calendar", category: "Navigation", effect: "navigate" }),
		command({ id: "drive.open", moduleId: "drive", category: "Drive", effect: "navigate" }),
	];
	const ids = (enabled) => listCategories(CLIENT_MODULES, enabled, commands, () => Icon).map((c) => c.id);
	assert.deepEqual(ids(ALL), [
		"all",
		"pages",
		"messages",
		"contacts",
		"actions",
		"settings",
		"module:calendar",
		// Money Watch answers a search section, so it is listed without a command of its own.
		"module:finance",
		"module:drive",
	]);
	assert.deepEqual(ids(["drive"]), ["all", "pages", "messages", "contacts", "actions", "settings", "module:drive"]);
	assert.deepEqual(
		ids([]).filter((id) => id.startsWith("module:")),
		[],
	);
	const [calendar] = listCategories(CLIENT_MODULES, ALL, commands, (name) =>
		name === "CalendarDays" ? Icon : null,
	).filter((c) => c.id === "module:calendar");
	assert.equal(calendar.label, "Calendar");
	assert.equal(calendar.icon, Icon);
	assert.equal(calendar.moduleId, "calendar");
	assert.equal(NUMBERED_CATEGORIES, 9);
});

test("commands sit under Pages, Settings, Actions or their module, with the badge of what they do", () => {
	assert.deepEqual(commandPlacement({ category: "Navigation" }), { category: "pages", type: "PAGE" });
	assert.deepEqual(commandPlacement({ category: "Settings", moduleId: "core" }), {
		category: "settings",
		type: "SETTING",
	});
	assert.deepEqual(commandPlacement({ category: "Actions" }), { category: "actions", type: "ACTION" });
	assert.deepEqual(commandPlacement({ category: "General" }), { category: "actions", type: "ACTION" });
	assert.deepEqual(commandPlacement({ category: "Navigation", moduleId: "calendar", effect: "navigate" }), {
		category: "module:calendar",
		type: "PAGE",
	});
	assert.deepEqual(commandPlacement({ category: "Actions", moduleId: "calendar", effect: "create" }), {
		category: "module:calendar",
		type: "ACTION",
	});
	const [item] = commandItems([
		command({ id: "compose", title: "Compose", subtitle: "Open", category: "Actions", shortcut: "c", icon: Icon }),
	]);
	assert.equal(item.id, "command:compose");
	assert.equal(item.category, "actions");
	assert.equal(item.type, "ACTION");
	assert.equal(item.shortcut, "c");
	assert.equal(item.icon, Icon);
	assert.deepEqual(
		[...commandHrefs([command({ href: "/settings/account" }), command({ id: "y" })])],
		["/settings/account"],
	);
});

test("settings pages become rows named after their menu, skipping pages a command already opens", () => {
	const opened = [];
	const groups = [
		{
			mode: "settings",
			sections: [
				{ label: "Account", items: [{ href: "/settings/account", label: "My account", icon: Icon }] },
				{ label: "Mail", items: [{ href: "/settings/inbox", label: "Inbox", icon: Icon }] },
			],
		},
		{
			mode: "admin",
			sections: [
				{ label: "", ariaLabel: "Admin overview", items: [{ href: "/admin", label: "Overview", icon: Icon }] },
			],
		},
	];
	const items = settingsItems(groups, new Set(["/settings/account"]), (href) => opened.push(href));
	assert.deepEqual(
		items.map((item) => [item.id, item.title, item.subtitle, item.type, item.category]),
		[
			["nav:/settings/inbox", "Inbox", "Settings · Mail", "SETTING", "settings"],
			["nav:/admin", "Overview", "Admin · Admin overview", "SETTING", "settings"],
		],
	);
	items[1].perform();
	assert.deepEqual(opened, ["/admin"]);
});

test("a message row names its other party and the date and opens in the folder its status lives in", () => {
	assert.equal(messageHref("received", "m 1"), "/inbox/m%201");
	assert.equal(messageHref("sent", "m"), "/sent/m");
	assert.equal(messageHref("queued", "m"), "/sent/m");
	assert.equal(messageHref("draft", "m"), "/drafts/m");
	assert.equal(messageHref("spam", "m"), "/spam/m");
	assert.equal(messageHref("trash", "m"), "/trash/m");
	assert.equal(messageHref("archived", "m"), "/archived/m");
	assert.equal(messageHref("screening", "m"), "/inbox/m");
	const inbound = {
		id: "m1",
		subject: "  Hello  ",
		fromAddr: '"Maya Chen" <maya@acme.test>',
		fromContactName: null,
		toAddr: "support@example.com",
		toContactName: null,
		direction: "inbound",
		status: "received",
		createdAt: "2026-10-09T10:00:00.000Z",
	};
	assert.equal(messageParty(inbound), "Maya Chen");
	assert.equal(messageParty({ ...inbound, fromContactName: "Maya" }), "Maya");
	assert.equal(messageParty({ ...inbound, fromAddr: "" }), "Unknown sender");
	assert.equal(messageParty({ ...inbound, direction: "outbound", toAddr: "a@x.test, b@x.test" }), "To a, +1");
	assert.equal(messageParty({ ...inbound, direction: "outbound", toAddr: "a@x.test", toContactName: "Ann" }), "To Ann");
	const opened = [];
	const item = messageItem(
		inbound,
		(href) => opened.push(href),
		() => "Oct 09",
	);
	assert.equal(item.title, "Hello");
	assert.equal(item.subtitle, "Maya Chen · Oct 09");
	assert.equal(item.type, "MESSAGE");
	assert.equal(item.category, "messages");
	item.perform();
	assert.deepEqual(opened, ["/inbox/m1"]);
	assert.equal(messageItem({ ...inbound, subject: null }, noop, () => "").title, "(No subject)");
});

test("a contact row shows the name over the address, says when it is blocked, and opens the sender's mail", () => {
	const opened = [];
	const named = contactItem(
		{ email: "maya@acme.test", displayName: "Maya Chen", hasAvatar: false, blocked: false },
		(email) => opened.push(email),
	);
	assert.deepEqual(
		[named.id, named.title, named.subtitle, named.type, named.category],
		["contact:maya@acme.test", "Maya Chen", "maya@acme.test", "CONTACT", "contacts"],
	);
	named.perform();
	assert.deepEqual(opened, ["maya@acme.test"]);
	const bare = contactItem({ email: "x@y.test", displayName: "  ", hasAvatar: false, blocked: true }, noop);
	assert.equal(bare.title, "x@y.test");
	assert.equal(bare.subtitle, "Search mail from this address · Blocked");
});

test("module records take the type from their ref kind and the module's icon", () => {
	assert.equal(refKindType("calendar:event"), "EVENT");
	assert.equal(refKindType("finance:subscription"), "SUBSCRIPTION");
	assert.equal(refKindType("booking:event_type"), "EVENT TYPE");
	assert.equal(refKindType("plain"), "PLAIN");
	const opened = [];
	const section = {
		id: "events",
		moduleId: "calendar",
		label: "Events",
		items: [
			{
				ref: { kind: "calendar:event", id: "e1" },
				label: "Standup",
				sublabel: "Mon 09:00",
				href: "/calendar?event=e1",
			},
			{ ref: { kind: "calendar:event", id: "e2" }, label: "Review", sublabel: "", href: "/calendar?event=e2" },
		],
	};
	const items = sectionItems(section, Icon, (href) => opened.push(href));
	assert.deepEqual(
		items.map((item) => [item.id, item.title, item.subtitle, item.type, item.category, item.icon]),
		[
			["calendar:event:e1", "Standup", "Mon 09:00", "EVENT", "module:calendar", Icon],
			["calendar:event:e2", "Review", "Events", "EVENT", "module:calendar", Icon],
		],
	);
	items[0].perform();
	assert.deepEqual(opened, ["/calendar?event=e1"]);
});

const categories = [
	{ id: "all", label: "All", icon: Icon },
	{ id: "pages", label: "Pages", icon: Icon },
	{ id: "messages", label: "Messages", icon: Icon },
	{ id: "contacts", label: "Contacts", icon: Icon },
	{ id: "actions", label: "Actions", icon: Icon },
	{ id: "settings", label: "Settings", icon: Icon },
	{ id: "module:calendar", label: "Calendar", icon: Icon },
];
const row = (id, category) => ({ id, category, type: "X", title: id, perform: noop });
const rows = [row("a", "pages"), row("b", "pages"), row("c", "actions"), row("d", "module:calendar")];

test("counts follow the rows, or a search's own total when it listed fewer, and All sums them", () => {
	assert.deepEqual(countItems(rows, categories), {
		all: 4,
		pages: 2,
		messages: 0,
		contacts: 0,
		actions: 1,
		settings: 0,
		"module:calendar": 1,
	});
	const counted = countItems([...rows, row("m", "messages")], categories, { messages: 23, contacts: undefined });
	assert.equal(counted.messages, 23);
	assert.equal(counted.all, 27);
	assert.equal(countItems([], categories, { messages: 0 }).all, 0);
});

test("groups keep the sidebar order, drop empty categories and narrow to the chosen one", () => {
	assert.deepEqual(
		groupItems(rows, categories, "all").map((group) => [group.category.id, group.items.map((item) => item.id)]),
		[
			["pages", ["a", "b"]],
			["actions", ["c"]],
			["module:calendar", ["d"]],
		],
	);
	assert.deepEqual(
		groupItems(rows, categories, "actions").map((group) => group.category.id),
		["actions"],
	);
	assert.deepEqual(groupItems(rows, categories, "messages"), []);
});

test("the highlight wraps with the arrows, jumps with Home and End, and clamps when rows disappear", () => {
	assert.equal(moveActive(0, 3, "ArrowDown"), 1);
	assert.equal(moveActive(2, 3, "ArrowDown"), 0);
	assert.equal(moveActive(0, 3, "ArrowUp"), 2);
	assert.equal(moveActive(1, 3, "ArrowUp"), 0);
	assert.equal(moveActive(1, 3, "Home"), 0);
	assert.equal(moveActive(1, 3, "End"), 2);
	assert.equal(moveActive(1, 3, "PageDown"), 1);
	assert.equal(moveActive(-1, 3, "ArrowDown"), 1);
	assert.equal(moveActive(5, 3, "ArrowUp"), 1);
	assert.equal(moveActive(0, 0, "ArrowDown"), -1);
	assert.equal(clampActive(0, 0), -1);
	assert.equal(clampActive(7, 3), 2);
	assert.equal(clampActive(-1, 3), 0);
	assert.equal(clampActive(1, 3), 1);
});

test("digits pick a category by position, without Ctrl or Cmd, which the browser owns", () => {
	const key = (code, extra = {}) => ({ code, ctrlKey: false, metaKey: false, ...extra });
	assert.equal(digitOf(key("Digit1")), 1);
	assert.equal(digitOf(key("Numpad9")), 9);
	assert.equal(digitOf(key("Digit0")), null);
	assert.equal(digitOf(key("KeyA")), null);
	assert.equal(digitOf(key("Digit2", { ctrlKey: true })), null);
	assert.equal(digitOf(key("Digit2", { metaKey: true })), null);
	assert.equal(categoryForDigit(categories, 1), "all");
	assert.equal(categoryForDigit(categories, 7), "module:calendar");
	assert.equal(categoryForDigit(categories, 8), null);
	assert.equal(categoryForDigit(categories, 0), null);
	assert.equal(categoryForDigit(categories, 10), null);
});

test("the sidebar arrows step through the categories in both directions and wrap", () => {
	assert.equal(adjacentCategory(categories, "all", "ArrowDown"), "pages");
	assert.equal(adjacentCategory(categories, "all", "ArrowRight"), "pages");
	assert.equal(adjacentCategory(categories, "all", "ArrowUp"), "module:calendar");
	assert.equal(adjacentCategory(categories, "module:calendar", "ArrowLeft"), "settings");
	assert.equal(adjacentCategory(categories, "module:calendar", "ArrowDown"), "all");
	assert.equal(adjacentCategory(categories, "pages", "Home"), "all");
	assert.equal(adjacentCategory(categories, "pages", "End"), "module:calendar");
	assert.equal(adjacentCategory(categories, "pages", "Enter"), "pages");
	assert.equal(adjacentCategory(categories, "missing", "ArrowDown"), "pages");
	assert.equal(adjacentCategory([], "all", "ArrowDown"), "all");
});

test("shortcuts are drawn as one chip per key and typing keys are the ones without modifiers", () => {
	assert.deepEqual(shortcutKeys("g i"), ["G", "I"]);
	assert.deepEqual(shortcutKeys("c"), ["C"]);
	assert.deepEqual(shortcutKeys("?"), ["?"]);
	assert.deepEqual(shortcutKeys("escape"), ["Esc"]);
	assert.deepEqual(shortcutKeys("Shift+Enter"), ["Shift+Enter"]);
	assert.deepEqual(shortcutKeys(" g  i "), ["G", "I"]);
	const key = (k, extra = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...extra });
	assert.equal(isTypingKey(key("a")), true);
	assert.equal(isTypingKey(key(" ")), true);
	assert.equal(isTypingKey(key("Enter")), false);
	assert.equal(isTypingKey(key("a", { ctrlKey: true })), false);
	assert.equal(isTypingKey(key("a", { metaKey: true })), false);
	assert.equal(isTypingKey(key("a", { altKey: true })), false);
});

test("the empty list explains itself per category", () => {
	assert.equal(emptyMessage("", "messages", false), "Type to search your mail");
	assert.equal(emptyMessage("", "contacts", false), "Type a name or an address");
	assert.equal(emptyMessage("", "module:calendar", false), "Type to search here");
	assert.equal(emptyMessage("", "all", false), "Nothing to show");
	assert.equal(emptyMessage("zzz", "all", true), "Searching…");
	assert.equal(emptyMessage("zzz", "pages", false), "No matching results for “zzz”");
});

test("the contacts search reads its limit and query defensively and escapes LIKE wildcards", () => {
	assert.equal(parseContactSearchLimit(null), 8);
	assert.equal(parseContactSearchLimit("abc"), 8);
	assert.equal(parseContactSearchLimit("0"), 1);
	assert.equal(parseContactSearchLimit("99"), 20);
	assert.equal(parseContactSearchLimit("3.7"), 3);
	assert.equal(normalizeContactQuery(null), "");
	assert.equal(normalizeContactQuery("  maya "), "maya");
	assert.equal(normalizeContactQuery("x".repeat(300)).length, 200);
	assert.equal(contactLikePattern("maya"), "%maya%");
	assert.equal(contactLikePattern("50%_off\\"), "%50\\%\\_off\\\\%");
	assert.deepEqual(
		toContactSearchHit({ email: "a@b.test", displayName: "A", avatarKey: "k", blocked: false, lastSeenAt: null }),
		{ email: "a@b.test", displayName: "A", hasAvatar: true, blocked: false },
	);
	assert.equal(
		toContactSearchHit({ email: "a@b.test", displayName: null, avatarKey: null, blocked: true, lastSeenAt: null })
			.hasAvatar,
		false,
	);
});
