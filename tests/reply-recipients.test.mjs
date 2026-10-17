import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-reply-recipients-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { getReplyRecipients, hasAdditionalRecipients } from "./src/components/message-actions/utils.ts";`,
		resolveDir: root,
		sourcefile: "reply-recipients-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { getReplyRecipients, hasAdditionalRecipients } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

const own = ["hello@example.com", "hello@example.org"];
const inbound = (fields) => ({
	direction: "inbound",
	fromAddr: "Visitor <visitor@example.net>",
	toAddr: "hello@example.com",
	ccAddr: null,
	...fields,
});

test("a reply goes to the sender and reply-all adds everyone else but the mailbox", () => {
	const message = inbound({ toAddr: "hello@example.com, friend@example.net", ccAddr: "colleague@example.net" });
	assert.deepEqual(getReplyRecipients(message, own, "reply"), { to: ["Visitor <visitor@example.net>"], cc: [] });
	assert.deepEqual(getReplyRecipients(message, own, "replyAll"), {
		to: ["Visitor <visitor@example.net>"],
		cc: ["friend@example.net", "colleague@example.net"],
	});
	assert.equal(hasAdditionalRecipients(message, own), true);
});

test("a reply keeps a sender that is one of the mailbox's own addresses", () => {
	for (const toAddr of own) {
		const message = inbound({ fromAddr: "Owner <hello@example.com>", toAddr });
		assert.deepEqual(getReplyRecipients(message, own, "reply"), { to: ["Owner <hello@example.com>"], cc: [] });
		assert.deepEqual(getReplyRecipients(message, own, "replyAll"), { to: ["Owner <hello@example.com>"], cc: [] });
		assert.equal(hasAdditionalRecipients(message, own), false);
	}
});

test("reply-all from an own alias still drops other own addresses and duplicates of the sender", () => {
	const message = inbound({
		fromAddr: "Owner <hello@example.com>",
		toAddr: "hello@example.org, Friend <friend@example.net>",
		ccAddr: "HELLO@example.com, FRIEND@example.net, colleague@example.net",
	});
	assert.deepEqual(getReplyRecipients(message, own, "replyAll"), {
		to: ["Owner <hello@example.com>"],
		cc: ["Friend <friend@example.net>", "colleague@example.net"],
	});
});

test("replying to sent mail re-addresses its recipients without the mailbox's own addresses", () => {
	const message = {
		direction: "outbound",
		fromAddr: "hello@example.com",
		toAddr: "hello@example.org, friend@example.net",
		ccAddr: "colleague@example.net, hello@example.com",
	};
	assert.deepEqual(getReplyRecipients(message, own, "reply"), { to: ["friend@example.net"], cc: [] });
	assert.deepEqual(getReplyRecipients(message, own, "replyAll"), {
		to: ["friend@example.net"],
		cc: ["colleague@example.net"],
	});
});

test("a message without a sender has nobody to reply to", () => {
	assert.deepEqual(getReplyRecipients(inbound({ fromAddr: "" }), own, "reply"), { to: [], cc: [] });
});
