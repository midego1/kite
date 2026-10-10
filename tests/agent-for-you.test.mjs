import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-for-you-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/agent/auto-read/for-you-utils.ts")],
	outfile: join(outDir, "for-you.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { FOR_YOU_KIND_LABELS, forYouVisible, groupForYou, keepListedSelection } = await import(
	pathToFileURL(join(outDir, "for-you.mjs")).href
);

const item = (id, kind, createdAt) => ({ id, kind, createdAt });

test("For you groups by kind in importance order, newest first within a group", () => {
	const groups = groupForYou([
		item("r1", "reply", "2026-10-01T10:00:00.000Z"),
		item("s1", "summary", "2026-10-03T10:00:00.000Z"),
		item("p1", "phishing", "2026-10-01T09:00:00.000Z"),
		item("r2", "reply", "2026-10-02T10:00:00.000Z"),
		item("p2", "phishing", "2026-10-04T09:00:00.000Z"),
	]);
	assert.deepEqual(
		groups.map((group) => [group.kind, group.items.map((entry) => entry.id)]),
		[
			["phishing", ["p2", "p1"]],
			["reply", ["r2", "r1"]],
			["summary", ["s1"]],
		],
	);
	assert.deepEqual(groupForYou([]), []);
});

test("equal or unreadable timestamps keep the API's order, and unknown kinds go last", () => {
	const groups = groupForYou([
		item("a", "reply", "2026-10-01T10:00:00.000Z"),
		item("b", "reply", "2026-10-01T10:00:00.000Z"),
		item("c", "reply", "not a date"),
		item("x", "mystery", "2026-10-05T10:00:00.000Z"),
		item("t", "task", "2026-10-05T10:00:00.000Z"),
	]);
	assert.deepEqual(
		groups.map((group) => [group.kind, group.items.map((entry) => entry.id)]),
		[
			["reply", ["a", "b", "c"]],
			["task", ["t"]],
			["mystery", ["x"]],
		],
	);
});

test("For you is visible while any full-access mailbox has automatic reading on", () => {
	assert.equal(forYouVisible([]), false);
	assert.equal(forYouVisible([{ autonomy: "off" }, { autonomy: "off" }]), false);
	assert.equal(forYouVisible([{ autonomy: "off" }, { autonomy: "suggest" }]), true);
});

test("the selection keeps only ids that are still listed", () => {
	const kept = keepListedSelection(new Set(["a", "b", "gone"]), [{ id: "a" }, { id: "b" }, { id: "c" }]);
	assert.deepEqual([...kept].sort(), ["a", "b"]);
});

test("every kind has a heading", () => {
	for (const kind of ["phishing", "calendar_invite", "reply", "task", "receipt", "summary"])
		assert.equal(typeof FOR_YOU_KIND_LABELS[kind], "string");
});
