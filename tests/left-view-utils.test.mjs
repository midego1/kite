import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Which messages left their list after an action, so the open reader closes when its message is one of them.

const outDir = makeBundleDirectory("kite-left-view-");
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: { leftView: fileURLToPath(import.meta.resolve("../src/components/messages/left-view-utils.ts")) },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
});
const { idsLeavingView, openMessageLeft } = await import(pathToFileURL(join(outDir, "leftView.mjs")).href);

test("moves out of the list leave the view; read state, star and restore do not", () => {
	for (const action of ["archive", "trash", "spam", "phishing", "inbox", "folder", "delete"])
		assert.deepEqual(idsLeavingView(action, ["a"]), ["a"], action);
	for (const action of ["read", "unread", "restore"]) assert.deepEqual(idsLeavingView(action, ["a"]), [], action);
});

test("a response's undo names what moved: conversation members added, refused mail left out", () => {
	const undo = (...ids) => ({ undo: ids.map((id) => ({ id, status: "received", folderId: null })) });
	assert.deepEqual(idsLeavingView("spam", ["open"], undo("first", "open")), ["first", "open"]);
	assert.deepEqual(idsLeavingView("trash", ["queued", "other"], undo("other")), ["other"]);
	assert.deepEqual(idsLeavingView("spam", ["sent"], undo()), []);
	assert.deepEqual(idsLeavingView("folder", ["a", "a"], null), ["a"]);
});

test("the reader closes only when its own message left", () => {
	assert.equal(openMessageLeft("open", ["first", "open"]), true);
	assert.equal(openMessageLeft("open", ["first"]), false);
	assert.equal(openMessageLeft(undefined, ["first"]), false);
});
