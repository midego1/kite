import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Which messages left which list after an action, so the open reader closes only when its message is gone from it.

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
const { bulkActionLeftView, leavesList, neighbourAfterLeaving } = await import(
	pathToFileURL(join(outDir, "leftView.mjs")).href
);

test("moves and Delete leave; read state and restore do not", () => {
	for (const action of ["archive", "trash", "spam", "phishing", "inbox", "folder"])
		assert.deepEqual(bulkActionLeftView(action, ["a"]), { kind: "move", ids: ["a"] }, action);
	assert.deepEqual(bulkActionLeftView("delete", ["a"]), { kind: "delete", ids: ["a"] });
	for (const action of ["read", "unread", "restore"]) assert.equal(bulkActionLeftView(action, ["a"]), null, action);
});

test("the server's moved list wins over the ids asked for, even when there is no undo", () => {
	assert.deepEqual(bulkActionLeftView("trash", ["failed"], { moved: ["failed"] }), { kind: "move", ids: ["failed"] });
	assert.deepEqual(bulkActionLeftView("archive", ["queued", "other"], { moved: ["other"] }).ids, ["other"]);
	assert.equal(bulkActionLeftView("spam", ["sent"], { moved: [] }), null);
	assert.deepEqual(bulkActionLeftView("folder", ["a", "a"], null).ids, ["a"]);
});

test("Starred keeps moved mail, snoozing leaves only the Inbox, waking leaves only Snoozed, Delete leaves all", () => {
	assert.equal(leavesList("move", "inbox"), true);
	assert.equal(leavesList("move", "inbox", "folder-1"), true);
	assert.equal(leavesList("move", "starred"), false);
	assert.equal(leavesList("delete", "starred"), true);
	assert.equal(leavesList("snooze", "inbox"), true);
	assert.equal(leavesList("snooze", "inbox", "folder-1"), false);
	assert.equal(leavesList("snooze", "snoozed"), false);
	assert.equal(leavesList("snooze", "starred"), false);
	assert.equal(leavesList("unsnooze", "snoozed"), true);
	assert.equal(leavesList("unsnooze", "inbox"), false);
});

test("the focus goes to the next remaining row, else the previous one", () => {
	assert.equal(neighbourAfterLeaving(["a", "b", "c"], "b", ["b"]), "c");
	assert.equal(neighbourAfterLeaving(["a", "b", "c"], "b", ["b", "c"]), "a");
	assert.equal(neighbourAfterLeaving(["a", "b", "c"], "c", ["c"]), "b");
	assert.equal(neighbourAfterLeaving(["b"], "b", ["b"]), null);
	assert.equal(neighbourAfterLeaving(["a"], "x", ["x"]), null);
});
