import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-command-center-for-you-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/command-center/for-you-card-utils.ts")],
	outfile: join(bundleDirectory, "for-you-card.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { FOR_YOU_CARD_LIMIT, forYouCardView, forYouKindLabel } = await import(
	pathToFileURL(join(bundleDirectory, "for-you-card.mjs")).href
);

const suggestion = (id, mailboxId, createdAt, overrides = {}) => ({
	id,
	mailboxId,
	messageId: `m-${id}`,
	kind: "reply",
	title: `Draft ${id}`,
	createdAt,
	message: { subject: `Subject ${id}`, from: "Lena Fischer <lena@contoso.test>" },
	messageRef: { kind: "mail:message", id: `m-${id}` },
	messageTarget: { href: `/inbox?message=m-${id}`, label: `Subject ${id}` },
	...overrides,
});
const mailboxes = [
	{ id: "a", address: "a@example.test", autonomy: "suggest" },
	{ id: "b", address: "b@example.test", autonomy: "off" },
];

test("kinds read as their chip: core kinds, module kinds, and an unknown kind as itself", () => {
	assert.equal(forYouKindLabel("reply"), "Reply");
	assert.equal(forYouKindLabel("phishing"), "Phishing");
	assert.equal(forYouKindLabel("calendar_invite"), "Invite");
	assert.equal(forYouKindLabel("subscription"), "Subscription");
	assert.equal(forYouKindLabel("summary"), "Summary");
	assert.equal(forYouKindLabel("something_new"), "something_new");
});

test("the card is hidden until the list is in and while every mailbox in view reads nothing", () => {
	const state = { loaded: true, suggestions: [suggestion("1", "a", "2026-11-01T10:00:00Z")], total: 1, mailboxes };
	assert.equal(forYouCardView({ ...state, loaded: false }, ["a"]).visible, false);
	assert.equal(forYouCardView(state, ["a"]).visible, true);
	// Only the mailbox that has automatic reading off is in view: hidden, as the sidebar item would be for it alone.
	assert.equal(forYouCardView(state, ["b"]).visible, false);
	assert.equal(forYouCardView(state, []).visible, false);
	assert.equal(forYouCardView({ ...state, mailboxes: [] }, ["a"]).visible, false);
	// One mailbox with it on is enough in the All mailboxes view.
	assert.equal(forYouCardView(state, ["a", "b"]).visible, true);
});

test("an empty list is visible with a zero count, so the card can say there is nothing", () => {
	const view = forYouCardView({ loaded: true, suggestions: [], total: 0, mailboxes }, ["a"]);
	assert.deepEqual(view, { visible: true, rows: [], count: 0, more: 0 });
});

test("rows are the newest suggestions of the mailboxes in view, with the rest counted", () => {
	const items = [
		suggestion("old", "a", "2026-11-01T08:00:00Z"),
		suggestion("other", "b", "2026-11-01T12:00:00Z"),
		...Array.from({ length: 5 }, (_, index) => suggestion(`n${index}`, "a", `2026-11-02T0${index}:00:00Z`)),
	];
	const all = [
		{ id: "a", address: "a@example.test", autonomy: "suggest" },
		{ id: "b", address: "b@example.test", autonomy: "suggest" },
	];
	const state = { loaded: true, suggestions: items, total: 7, mailboxes: all };
	const everything = forYouCardView(state, ["a", "b"]);
	assert.equal(FOR_YOU_CARD_LIMIT, 4);
	assert.deepEqual(
		everything.rows.map((row) => row.id),
		["n4", "n3", "n2", "n1"],
	);
	assert.equal(everything.count, 7);
	assert.equal(everything.more, 3);
	// One mailbox: only its own suggestions, counted from the list.
	const single = forYouCardView(state, ["b"]);
	assert.deepEqual(
		single.rows.map((row) => row.id),
		["other"],
	);
	assert.deepEqual([single.count, single.more], [1, 0]);
	const first = everything.rows[0];
	assert.deepEqual(
		{ kind: first.kind, kindLabel: first.kindLabel, subject: first.subject, sender: first.sender, href: first.href },
		{ kind: "reply", kindLabel: "Reply", subject: "Subject n4", sender: "Lena Fischer", href: "/inbox?message=m-n4" },
	);
});

test("the total counts suggestions beyond a truncated list when every mailbox is in view", () => {
	const state = {
		loaded: true,
		suggestions: [suggestion("1", "a", "2026-11-01T10:00:00Z")],
		total: 250,
		mailboxes: [mailboxes[0]],
	};
	const view = forYouCardView(state, ["a"]);
	assert.deepEqual([view.count, view.more], [250, 249]);
});

test("a row falls back to the title without a subject, the address without a name, and no link when unreachable", () => {
	const view = forYouCardView(
		{
			loaded: true,
			suggestions: [
				suggestion("x", "a", "2026-11-01T10:00:00Z", {
					message: { subject: null, from: "plain@contoso.test" },
					messageTarget: { href: null, label: "x" },
				}),
				suggestion("y", "a", "2026-11-01T09:00:00Z", { message: { subject: "  ", from: null }, title: "" }),
			],
			total: 2,
			mailboxes: [mailboxes[0]],
		},
		["a"],
	);
	assert.deepEqual(
		view.rows.map((row) => [row.subject, row.sender, row.href]),
		[
			["Draft x", "plain", null],
			["(No subject)", "", "/inbox?message=m-y"],
		],
	);
});
