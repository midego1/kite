import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	cleanDisplayText,
	utf8Excerpt,
	pickMessageHeaders,
	recentBounds,
	containsPattern,
	isFromSender,
	cleanNotice,
	ownedActionDescriptor,
	refusedAction,
	MAX_MESSAGE_TEXT_BYTES,
	listMessageSlots,
	listComposerSlots,
	slotsToLoad,
} = await bundleModules("kite-module-host-utils-", [
	["cleanDisplayText", "src/lib/modules/display-text-utils.ts"],
	[
		"utf8Excerpt, pickMessageHeaders, recentBounds, containsPattern, isFromSender, cleanNotice, ownedActionDescriptor, refusedAction, MAX_MESSAGE_TEXT_BYTES",
		"src/lib/modules/host-utils.ts",
	],
	["listMessageSlots, listComposerSlots, slotsToLoad", "src/lib/modules/composer-slot-utils.ts"],
]);

const bytes = (text) => new TextEncoder().encode(text).length;

test("display text drops bidi characters, collapses controls and cuts with an ellipsis", () => {
	assert.equal(cleanDisplayText("  a\u202eb\nc\t\td  ", 120), "ab c d");
	assert.equal(cleanDisplayText("\u200e\u0000 ", 120), undefined);
	assert.equal(cleanDisplayText(42, 120), undefined);
	assert.equal(cleanDisplayText("abcdef", 4), "abc…");
	assert.equal(cleanDisplayText("😀😀😀", 2), "😀…");
});

test("a UTF-8 excerpt fits the byte budget without splitting a character", () => {
	assert.equal(utf8Excerpt("hello", 3), "hel");
	assert.equal(utf8Excerpt("héllo", 2), "h");
	assert.equal(utf8Excerpt("héllo", 3), "hé");
	assert.equal(utf8Excerpt("a😀b", 4), "a");
	assert.equal(utf8Excerpt("a😀b", 5), "a😀");
	assert.equal(utf8Excerpt("日本語", 7), "日本");
	assert.equal(utf8Excerpt("", 10), null);
	assert.equal(utf8Excerpt(null, 10), null);
	assert.equal(utf8Excerpt("abc", 0), null);
	assert.equal(utf8Excerpt("abc", -5), null);
	assert.equal(utf8Excerpt("abc", 2.9), "ab");
	const long = "x".repeat(MAX_MESSAGE_TEXT_BYTES + 100);
	assert.equal(bytes(utf8Excerpt(long, 10_000_000)), MAX_MESSAGE_TEXT_BYTES, "capped at 64 KB");
});

test("only the asked-for list headers are picked, trimmed, cut and null when missing", () => {
	const headers = {
		"list-unsubscribe": "  <https://vendor.example/u>  ",
		"list-id": "",
		"x-secret": "nope",
		"list-unsubscribe-post": "y".repeat(5000),
	};
	assert.deepEqual(pickMessageHeaders(headers, ["list-unsubscribe", "list-id"]), {
		"list-unsubscribe": "<https://vendor.example/u>",
		"list-id": null,
	});
	assert.equal(pickMessageHeaders(headers, ["list-unsubscribe-post"])["list-unsubscribe-post"].length, 4096);
	assert.deepEqual(pickMessageHeaders(headers, ["x-secret", "constructor"]), {});
	assert.deepEqual(pickMessageHeaders(Object.create({ "list-id": "inherited" }), ["list-id"]), { "list-id": null });
});

test("recent-message bounds normalize the sender and clamp the window and the count", () => {
	const before = "2030-05-01T00:00:00.000Z";
	const bounds = recentBounds({
		mailboxId: "m",
		sender: "Vendor <Billing@Vendor.Example>",
		before,
		sinceDays: 400,
		limit: 9,
	});
	assert.equal(bounds.sender, "billing@vendor.example");
	assert.equal(bounds.limit, 5);
	assert.equal(bounds.before.toISOString(), before);
	assert.equal(bounds.since.toISOString(), new Date(Date.parse(before) - 400 * 86_400_000).toISOString());
	assert.equal(recentBounds({ mailboxId: "m", sender: "a@b.test", before, sinceDays: 0, limit: 0 }).limit, 1);
	const huge = recentBounds({ mailboxId: "m", sender: "a@b.test", before, sinceDays: 99_999, limit: Number.NaN });
	assert.equal(huge.limit, 5);
	assert.equal(huge.since.toISOString(), new Date(Date.parse(before) - 1000 * 86_400_000).toISOString());
	assert.equal(
		recentBounds({ mailboxId: "m", sender: "a@b.test", before, sinceDays: Number.NaN, limit: 2 }).since.toISOString(),
		new Date(Date.parse(before) - 86_400_000).toISOString(),
	);
	assert.equal(recentBounds({ mailboxId: "m", sender: "nobody", before, sinceDays: 1, limit: 1 }), null);
	assert.equal(recentBounds({ mailboxId: "m", sender: 7, before, sinceDays: 1, limit: 1 }), null);
	assert.equal(recentBounds({ mailboxId: "m", sender: "a@b.test", before: "soon", sinceDays: 1, limit: 1 }), null);
});

test("the sender pattern escapes LIKE wildcards and the exact check rejects look-alike addresses", () => {
	assert.equal(containsPattern("a_b%c\\d@x.test"), "%a\\_b\\%c\\\\d@x.test%");
	assert.equal(isFromSender("Vendor <Billing@Vendor.Example>", "billing@vendor.example"), true);
	assert.equal(isFromSender("billing@vendor.example", "billing@vendor.example"), true);
	assert.equal(isFromSender("x.billing@vendor.example", "billing@vendor.example"), false);
	assert.equal(isFromSender("billing@vendor.example.evil.test", "billing@vendor.example"), false);
});

test("a notice keeps a same-origin link, caps its title and body and refuses anything unusable", () => {
	assert.deepEqual(
		cleanNotice({ notice: "renewal_due", title: "Renews\nsoon", body: "  in 3 days ", href: "/finance?x=1" }),
		{ notice: "renewal_due", title: "Renews soon", body: "in 3 days", href: "/finance?x=1" },
	);
	const long = cleanNotice({ notice: "n", title: "t".repeat(500), body: "b".repeat(500) });
	assert.equal(Array.from(long.title).length, 120);
	assert.equal(Array.from(long.body).length, 300);
	assert.equal(long.href, null);
	assert.equal(cleanNotice({ notice: "n", title: "t", body: " " }).body, null);
	for (const href of ["https://evil.test/", "//evil.test", "/\\evil.test", "javascript:alert(1)", "", "/a\nb"])
		assert.equal(cleanNotice({ notice: "n", title: "t", href }), null, href);
	assert.equal(cleanNotice({ notice: "Bad Id", title: "t" }), null);
	assert.equal(cleanNotice({ notice: "n", title: "\u202e " }), null);
	assert.equal(cleanNotice(null), null);
});

test("a module may execute only its own action descriptors", () => {
	const all = [
		{
			moduleId: "calendar",
			descriptors: [
				{ name: "createEvent", surfaces: ["action"], action: { actionType: "create_event" } },
				{ name: "invite", surfaces: ["triage_step"] },
			],
		},
		{ moduleId: "finance", descriptors: [{ name: "track", surfaces: ["action"], action: { actionType: "t" } }] },
	];
	assert.equal(ownedActionDescriptor(all, "finance", "track").action.actionType, "t");
	assert.deepEqual(ownedActionDescriptor(all, "finance", "createEvent"), {
		status: 403,
		error: "This action belongs to another module",
	});
	assert.equal(ownedActionDescriptor(all, "calendar", "invite").status, 404);
	assert.equal(ownedActionDescriptor(all, "booking", "nothing").status, 404);
});

test("executor refusals map to 403 for missing permissions and 409 otherwise", () => {
	assert.deepEqual(refusedAction("missing_manage"), { ok: false, status: 403, error: "missing_manage" });
	assert.deepEqual(refusedAction("module_disabled:finance"), {
		ok: false,
		status: 409,
		error: "module_disabled:finance",
	});
	assert.equal(refusedAction(null).status, 409);
});

test("message menu slots list enabled modules only, in order, and load only once the menu opened", () => {
	const modules = [
		{ id: "calendar", messageSlots: [{ id: "calendar.b", slot: "message-menu", order: 60, label: "B" }] },
		{
			id: "finance",
			messageSlots: [
				{ id: "finance.a", slot: "message-menu", order: 50, label: "A" },
				{ id: "finance.c", slot: "message-menu", order: 61, label: "C" },
			],
			composerSlots: [{ id: "finance.send", slot: "send-menu", order: 1, label: "S" }],
		},
		{ id: "import" },
	];
	const listed = listMessageSlots(modules, ["calendar", "finance", "import"], "message-menu");
	assert.deepEqual(
		listed.map((slot) => [slot.id, slot.moduleId]),
		[
			["finance.a", "finance"],
			["calendar.b", "calendar"],
			["finance.c", "finance"],
		],
	);
	assert.deepEqual(
		listMessageSlots(modules, ["calendar"], "message-menu").map((slot) => slot.id),
		["calendar.b"],
	);
	assert.deepEqual(listMessageSlots(modules, [], "message-menu"), []);
	assert.deepEqual(
		listComposerSlots(modules, ["finance"], "send-menu").map((slot) => slot.id),
		["finance.send"],
	);
	assert.deepEqual(slotsToLoad(listed, false), []);
	assert.equal(slotsToLoad(listed, true).length, 3);
});
