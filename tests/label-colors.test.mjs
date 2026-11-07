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
// Kite classic's dark list: the selected stacked row and the hovered row.
const DARK_ROWS = ["#141414", "#1a1a1a", "#202020", "#262626", "#303134", "#35363a"];

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

const idsOf = (count) => Array.from({ length: count }, (_, index) => `mbx_${index}-abc`);

test("the user's mailboxes get distinct automatic colours from the palette, whatever order they are listed in", () => {
	const palette = new Set(LABEL_COLORS.map((color) => color.id));
	for (const count of [1, 2, 4, 6, 8]) {
		const colors = automaticMailboxColors(idsOf(count));
		assert.equal(new Set(colors.values()).size, count, `${count} mailboxes, all different`);
		for (const color of colors.values()) assert.ok(palette.has(color));
	}
	assert.deepEqual(
		[...automaticMailboxColors(idsOf(8)).entries()].sort(),
		[...automaticMailboxColors([...idsOf(8)].reverse()).entries()].sort(),
	);
	// More mailboxes than colours: every one still gets a colour of the palette.
	const crowd = automaticMailboxColors(idsOf(11));
	assert.equal(crowd.size, 11);
	for (const color of crowd.values()) assert.ok(palette.has(color));
});

test("adding a mailbox leaves most automatic colours where they were, and removing one moves at most the ones after it", () => {
	let moved = 0;
	let total = 0;
	for (let round = 0; round < 40; round++) {
		const ids = Array.from({ length: 4 }, (_, index) => `mbx_r${round}_${index}`);
		const before = automaticMailboxColors(ids);
		const after = automaticMailboxColors([...ids, `mbx_r${round}_new`]);
		for (const id of ids) {
			total++;
			if (before.get(id) !== after.get(id)) moved++;
		}
	}
	assert.ok(moved / total < 0.2, `${moved} of ${total} existing mailboxes changed colour when one was added`);
	// A mailbox alone gets its own hash colour, and a chosen colour never moves.
	const automatic = automaticMailboxColors(["mbx_1"]);
	assert.equal(mailboxLabelColor(undefined, { id: "mbx_1" }, automatic).chosen, false);
	assert.equal(mailboxLabelColor({ mailboxes: { mbx_1: "red" } }, { id: "mbx_1" }, automatic).id, "red");
});

test("a chosen colour wins over the automatic one, per mailbox and per account", () => {
	const mailbox = { id: "box-1" };
	const auto = automaticMailboxColors(["box-1", "box-2"]);
	const automatic = mailboxLabelColor(undefined, mailbox, auto);
	assert.equal(automatic.chosen, false);
	assert.equal(automatic.id, auto.get("box-1"));
	const chosen = mailboxLabelColor({ mailboxes: { "box-1": "pink" } }, mailbox, auto);
	assert.deepEqual(chosen, { id: "pink", value: "#e64a92", chosen: true });
	assert.equal(mailboxLabelColor({ mailboxes: { "box-2": "pink" } }, mailbox, auto).chosen, false);
	assert.equal(accountLabelColor(undefined, "acc-1"), null);
	assert.equal(accountLabelColor({ accounts: { "acc-1": "teal" } }, "acc-1"), "#25958d");
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
