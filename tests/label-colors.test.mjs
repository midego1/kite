import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// The colours of the marks in the message list: the palette, the automatic mailbox colour, what a choice and the
// cleanup of gone mailboxes do to the stored map, and how the layout keeps them.

const {
	LABEL_COLORS,
	automaticMailboxColors,
	mailboxLabelColor,
	accountLabelColor,
	withLabelColor,
	pruneLabelColors,
	hasStaleLabelColors,
	parseStoredLabelColors,
	parseStoredLayout,
	parseLayoutPatch,
	layoutStorageEntries,
} = await bundleModules("kite-label-colors-", [
	[
		"LABEL_COLORS, automaticMailboxColors, mailboxLabelColor, accountLabelColor, withLabelColor, pruneLabelColors, hasStaleLabelColors, parseStoredLabelColors",
		"src/components/messages/label-colors-utils.ts",
	],
	["parseStoredLayout, parseLayoutPatch", "src/lib/preferences/layout-utils.ts"],
	["layoutStorageEntries", "src/components/layout-preferences-utils.ts"],
]);

const linear = (channel) => {
	const value = channel / 255;
	return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
	const n = Number.parseInt(hex.slice(1), 16);
	return 0.2126 * linear(n >> 16) + 0.7152 * linear((n >> 8) & 255) + 0.0722 * linear(n & 255);
};
const contrast = (a, b) => {
	const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (lighter + 0.05) / (darker + 0.05);
};

// What a row sits on: the page and card whites, the hover and selected greys, the Lavender and Classic selected tints
// (light), and the dark theme's page, card, hover and selected greys (src/app/globals.css).
const LIGHT_ROWS = ["#ffffff", "#fafafa", "#f4f4f5", "#f3f2ff", "#eff6ff"];
const DARK_ROWS = ["#141414", "#1a1a1a", "#202020", "#262626"];

test("the palette has eight colours, and the layout accepts exactly those", () => {
	assert.equal(LABEL_COLORS.length, 8);
	assert.equal(new Set(LABEL_COLORS.map((color) => color.value)).size, 8);
	for (const color of LABEL_COLORS) {
		const layout = parseStoredLayout(JSON.stringify({ labelColors: { mailboxes: { box: color.id } } }));
		assert.deepEqual(layout, { labelColors: { mailboxes: { box: color.id } } }, color.id);
	}
	for (const other of ["mauve", "BLUE", "#3070f0", "", "default"])
		assert.deepEqual(parseStoredLayout(JSON.stringify({ labelColors: { mailboxes: { box: other } } })), {
			labelColors: {},
		});
});

test("every colour reads on every row background, in light and dark, at 3:1", () => {
	for (const color of LABEL_COLORS)
		for (const row of [...LIGHT_ROWS, ...DARK_ROWS])
			assert.ok(contrast(color.value, row) >= 3, `${color.id} on ${row}: ${contrast(color.value, row).toFixed(2)}`);
});

/** What a mailbox gets on its own: the colour its address hashes to, with no other mailbox to avoid. */
const alone = (address) => automaticMailboxColors([{ id: "only", address }]).get("only");

test("a mailbox's automatic colour is stable, case-blind and from the palette", () => {
	const ids = new Set(LABEL_COLORS.map((color) => color.id));
	for (const address of ["me@example.com", "work@example.com", "help@example.org", ""])
		assert.ok(ids.has(alone(address)));
	assert.equal(alone("Me@Example.com "), alone("me@example.com"));
	const used = new Set(Array.from({ length: 40 }, (_, index) => alone(`box${index}@example.com`)));
	assert.ok(used.size >= 5, `automatic colours spread over the palette (${used.size})`);
});

test("the user's own mailboxes get different automatic colours, whatever order they are listed in", () => {
	const mailboxes = Array.from({ length: 8 }, (_, index) => ({
		id: `box-${index}`,
		address: `box${index}@example.com`,
	}));
	for (const count of [2, 3, 5, 8]) {
		const colors = automaticMailboxColors(mailboxes.slice(0, count));
		assert.equal(new Set(colors.values()).size, count, `${count} mailboxes, all different`);
	}
	const forward = automaticMailboxColors(mailboxes);
	const backward = automaticMailboxColors([...mailboxes].reverse());
	assert.deepEqual([...forward.entries()].sort(), [...backward.entries()].sort());
	// Stable: the same mailboxes get the same colours again, and a mailbox that does not collide keeps its hash colour.
	assert.deepEqual([...automaticMailboxColors(mailboxes).entries()], [...forward.entries()]);
	assert.equal(automaticMailboxColors([mailboxes[0]]).get("box-0"), alone(mailboxes[0].address));
	// More mailboxes than colours: every one still gets a colour of the palette.
	const crowd = Array.from({ length: 11 }, (_, index) => ({ id: `m${index}`, address: `m${index}@example.org` }));
	const ids = new Set(LABEL_COLORS.map((color) => color.id));
	assert.equal(automaticMailboxColors(crowd).size, 11);
	for (const color of automaticMailboxColors(crowd).values()) assert.ok(ids.has(color));
	// A set colour wins, and the automatic ones come from the given set.
	assert.equal(mailboxLabelColor({ mailboxes: { "box-1": "red" } }, mailboxes[1], forward).id, "red");
	assert.equal(mailboxLabelColor(undefined, mailboxes[1], forward).id, forward.get("box-1"));
});

test("a chosen colour wins over the automatic one, per mailbox and per account", () => {
	const mailbox = { id: "box-1", address: "me@example.com" };
	const automatic = mailboxLabelColor(undefined, mailbox);
	assert.equal(automatic.chosen, false);
	assert.equal(automatic.id, alone(mailbox.address));
	const chosen = mailboxLabelColor({ mailboxes: { "box-1": "pink" } }, mailbox);
	assert.deepEqual(chosen, { id: "pink", value: "#e22d80", chosen: true });
	assert.equal(mailboxLabelColor({ mailboxes: { "box-2": "pink" } }, mailbox).chosen, false);
	assert.equal(accountLabelColor(undefined, "acc-1"), null);
	assert.equal(accountLabelColor({ accounts: { "acc-1": "teal" } }, "acc-1"), "#0f8b82");
	assert.equal(accountLabelColor({ mailboxes: { "acc-1": "teal" } }, "acc-1"), null);
});

test("choosing and clearing a colour edits one entry and leaves the rest", () => {
	let colors = withLabelColor(undefined, "mailboxes", "box-1", "red");
	colors = withLabelColor(colors, "accounts", "acc-1", "blue");
	colors = withLabelColor(colors, "mailboxes", "box-2", "green");
	assert.deepEqual(colors, { mailboxes: { "box-1": "red", "box-2": "green" }, accounts: { "acc-1": "blue" } });
	colors = withLabelColor(colors, "mailboxes", "box-1", null);
	assert.deepEqual(colors, { mailboxes: { "box-2": "green" }, accounts: { "acc-1": "blue" } });
	colors = withLabelColor(withLabelColor(colors, "mailboxes", "box-2", null), "accounts", "acc-1", null);
	assert.deepEqual(colors, {});
});

test("entries of mailboxes and accounts that are gone are dropped, and a list not known yet protects its kind", () => {
	const colors = {
		mailboxes: { "box-1": "red", "gone-box": "blue" },
		accounts: { "acc-1": "teal", "gone-acc": "pink" },
	};
	assert.deepEqual(pruneLabelColors(colors, { mailboxes: ["box-1"], accounts: ["acc-1"] }), {
		mailboxes: { "box-1": "red" },
		accounts: { "acc-1": "teal" },
	});
	// Accounts still loading (undefined): their entries stay, whatever the mailboxes say.
	assert.deepEqual(pruneLabelColors(colors, { mailboxes: ["box-1"] }), {
		mailboxes: { "box-1": "red" },
		accounts: { "acc-1": "teal", "gone-acc": "pink" },
	});
	// A kind with nothing left disappears; a known empty list drops them all.
	assert.deepEqual(pruneLabelColors(colors, { mailboxes: [], accounts: ["acc-1"] }), { accounts: { "acc-1": "teal" } });
	assert.deepEqual(pruneLabelColors(colors, {}), colors);
	assert.equal(
		hasStaleLabelColors(colors, { mailboxes: ["box-1", "gone-box"], accounts: ["acc-1", "gone-acc"] }),
		false,
	);
	assert.equal(hasStaleLabelColors(colors, { mailboxes: ["box-1"] }), true);
	assert.equal(hasStaleLabelColors({}, { mailboxes: [], accounts: [] }), false);
});

test("the browser's stored colours keep only valid entries", () => {
	assert.deepEqual(parseStoredLabelColors(null), {});
	assert.deepEqual(parseStoredLabelColors("not json"), {});
	assert.deepEqual(parseStoredLabelColors("[]"), {});
	assert.deepEqual(
		parseStoredLabelColors(
			JSON.stringify({
				mailboxes: { "box-1": "red", "box-2": "mauve", "": "red", "box-3": 4 },
				accounts: ["red"],
				unknown: { a: "red" },
			}),
		),
		{ mailboxes: { "box-1": "red" } },
	);
});

test("the account layout keeps colours by mailbox and account, clamped and cleaned", () => {
	const parse = (labelColors) => parseStoredLayout(JSON.stringify({ labelColors }));
	assert.deepEqual(parse({ mailboxes: { "box-1": "red" }, accounts: { "acc-1": "teal" } }), {
		labelColors: { mailboxes: { "box-1": "red" }, accounts: { "acc-1": "teal" } },
	});
	// "No colour chosen" is a value that can be saved, so clearing the last one reaches the server.
	assert.deepEqual(parse({}), { labelColors: {} });
	assert.deepEqual(parse({ mailboxes: { "box-1": "mauve" }, accounts: "teal" }), { labelColors: {} });
	for (const value of [null, "red", ["red"], 3]) assert.deepEqual(parse(value), {});
	assert.deepEqual(parse({ mailboxes: { ["x".repeat(101)]: "red", ok: "red" } }), {
		labelColors: { mailboxes: { ok: "red" } },
	});
	const many = Object.fromEntries(Array.from({ length: 220 }, (_, index) => [`box-${index}`, "red"]));
	// At most 200 entries per kind are kept.
	assert.equal(Object.keys(parse({ mailboxes: many }).labelColors.mailboxes).length, 200);
	assert.deepEqual(parseLayoutPatch({ layout: { labelColors: {} } }), { labelColors: {} });
	assert.equal(parseLayoutPatch({ layout: { labelColors: "red" } }), null);
});

test("the layout's colours are written to the browser in the format the views read", () => {
	const labelColors = { mailboxes: { "box-1": "red" }, accounts: { "acc-1": "teal" } };
	assert.deepEqual(layoutStorageEntries({ labelColors }, "user-1"), [
		["kite-label-colors", JSON.stringify(labelColors)],
	]);
	assert.deepEqual(layoutStorageEntries({}, "user-1"), []);
});
