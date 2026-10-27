import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-list-keyboard-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export * from "./src/components/messages/message-list-keyboard-utils.ts"; export * from "./src/components/messages/message-row-badges-utils.ts"; export * from "./src/components/shortcuts/mail-key-hints-utils.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { adjacentRowIndex, getMessageRowBadges, listShortcuts, withMailKeyHints } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

test("j starts at the first row and k at the last when no row has focus", () => {
	assert.equal(adjacentRowIndex(5, -1, 1), 0);
	assert.equal(adjacentRowIndex(5, -1, -1), 4);
});

test("j and k move one row and stop at the ends", () => {
	assert.equal(adjacentRowIndex(5, 2, 1), 3);
	assert.equal(adjacentRowIndex(5, 2, -1), 1);
	assert.equal(adjacentRowIndex(5, 4, 1), 4);
	assert.equal(adjacentRowIndex(5, 0, -1), 0);
	assert.equal(adjacentRowIndex(0, -1, 1), -1);
});

test("rows show a suspicious verdict outside Spam and a future snooze outside Snoozed", () => {
	const now = Date.parse("2026-10-26T10:00:00Z");
	const later = "2026-10-27T10:00:00Z";
	assert.deepEqual(
		getMessageRowBadges({ spamVerdict: "suspicious", snoozedUntil: later }, "inbox", now).map((badge) => badge.label),
		["Suspicious", "Snoozed"],
	);
	assert.deepEqual(getMessageRowBadges({ spamVerdict: "suspicious", snoozedUntil: later }, "spam", now).length, 1);
	assert.deepEqual(getMessageRowBadges({ spamVerdict: "suspicious", snoozedUntil: later }, "snoozed", now).length, 1);
	assert.deepEqual(
		getMessageRowBadges({ spamVerdict: "inbox", snoozedUntil: "2026-10-25T10:00:00Z" }, "inbox", now),
		[],
	);
});

test("the shortcuts sheet lists the keys the list and the reader actually bind", () => {
	const mailKeyHints = () => withMailKeyHints([]);
	const keys = new Set(mailKeyHints().map((hint) => hint.key));
	for (const key of ["j", "k", "o", "x", "e", "#", "y", "!", "r", "a", "f", "u"]) assert.ok(keys.has(key), key);
	const noop = () => {};
	const bound = listShortcuts({ next: noop, previous: noop, open: noop, select: noop, archive: noop, trash: noop });
	for (const binding of bound)
		assert.ok(
			mailKeyHints().some((hint) => hint.key === binding.key && hint.label === binding.label),
			binding.label,
		);
	assert.ok(mailKeyHints().every((hint) => !("action" in hint)));
});

test("a key and label the provider already lists appear once", () => {
	const listed = withMailKeyHints([{ key: "e", label: "Archive", category: "Actions" }]);
	assert.equal(listed.filter((hint) => hint.key === "e" && hint.label === "Archive").length, 1);
});
