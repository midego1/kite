import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-home-mailbox-state-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/app/home-mailbox-state-utils.ts")],
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	packages: "external",
	logLevel: "silent",
});
const { createMailboxState, reduceMailbox, listEmails, unreadCount, WELCOME_ID } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

const sample = (id, text = id) => ({
	id,
	folder: "inbox",
	text,
	sample: { sender: { name: id, address: `${id}@example.test` } },
});
const emails = [
	{ id: WELCOME_ID, folder: "inbox", text: "welcome" },
	sample("first"),
	sample("second"),
	sample("third"),
];
const run = (state, ...actions) => actions.reduce((current, action) => reduceMailbox(current, action, emails), state);

test("opening a denied example does nothing, so Back cannot bring it back", () => {
	const denied = run(
		createMailboxState(),
		{ type: "open", id: "second" },
		{ type: "decideSender", id: "second", approve: false },
	);
	assert.equal(denied.openId, "third");
	assert.deepEqual(run(denied, { type: "open", id: "second" }), denied);
	assert.deepEqual(run(denied, { type: "move", direction: -1 }).openId, "first");
});

test("denying the only search result shows Welcome instead of a blank reader", () => {
	const state = run(
		createMailboxState(),
		{ type: "search", text: "second" },
		{ type: "open", id: "second" },
		{ type: "decideSender", id: "second", approve: false },
	);
	assert.deepEqual(listEmails(state, emails), []);
	assert.equal(state.openId, WELCOME_ID);
	assert.equal(state.pane, "list");
	assert.equal(state.search, "second");
});

test("denying the only starred email shows Welcome and keeps the Starred view", () => {
	const state = run(
		createMailboxState(),
		{ type: "open", id: "first" },
		{ type: "star", id: "first" },
		{ type: "view", view: "starred" },
		{ type: "decideSender", id: "first", approve: false },
	);
	assert.deepEqual(listEmails(state, emails), []);
	assert.equal(state.openId, WELCOME_ID);
	assert.equal(state.view, "starred");
});

test("a denied example that was still unread leaves the folder count", () => {
	const unread = { ...createMailboxState(), read: [WELCOME_ID] };
	assert.equal(unreadCount(unread, emails, "inbox"), 3);
	const denied = reduceMailbox(unread, { type: "decideSender", id: "second", approve: false }, emails);
	assert.equal(denied.read.includes("second"), false);
	assert.equal(unreadCount(denied, emails, "inbox"), 2);
});
