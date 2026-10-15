import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-suggestion-badge-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// The utils read the modules' client data through the `@/` alias, so they are bundled rather than imported.
await build({
	entryPoints: [join(root, "src/lib/agent/auto-read/suggestion-badge-utils.ts")],
	outfile: join(outDir, "suggestion-badge.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { groupSuggestionCounts, pickSuggestionBadge } = await import(
	pathToFileURL(join(outDir, "suggestion-badge.mjs")).href
);

test("badge priority is phishing > calendar_invite > reply > task > receipt, and summaries get no chip", () => {
	assert.equal(pickSuggestionBadge([]), null);
	assert.equal(pickSuggestionBadge([{ kind: "summary", count: 3 }]), null);
	assert.deepEqual(
		pickSuggestionBadge([
			{ kind: "reply", count: 1 },
			{ kind: "phishing", count: 1 },
			{ kind: "summary", count: 1 },
		]),
		{ kind: "phishing", more: 1 },
	);
	assert.deepEqual(
		pickSuggestionBadge([
			{ kind: "receipt", count: 1 },
			{ kind: "calendar_invite", count: 2 },
		]),
		{ kind: "calendar_invite", more: 2 },
	);
	assert.deepEqual(
		pickSuggestionBadge([
			{ kind: "receipt", count: 1 },
			{ kind: "task", count: 1 },
		]),
		{ kind: "task", more: 1 },
	);
	assert.deepEqual(pickSuggestionBadge([{ kind: "reply", count: 1 }]), { kind: "reply", more: 0 });
	assert.deepEqual(
		pickSuggestionBadge([
			{ kind: "receipt", count: 1 },
			{ kind: "label", count: 4 },
		]),
		{
			kind: "receipt",
			more: 0,
		},
	);
	assert.equal(pickSuggestionBadge([{ kind: "reply", count: 0 }]), null);
});

test("row suggestion counts aggregate over the messages a row stands for", () => {
	const counts = [
		{ messageId: "a", kind: "phishing", count: 1 },
		{ messageId: "b", kind: "reply", count: 1 },
		{ messageId: "b", kind: "summary", count: 1 },
		{ messageId: "c", kind: "reply", count: 1 },
		{ messageId: "c", kind: "reply", count: 1 },
	];
	const grouped = groupSuggestionCounts(counts, [
		{ id: "thread", messageIds: ["b", "a", "a"] },
		{ id: "b", messageIds: ["b"] },
		{ id: "c", messageIds: ["c"] },
		{ id: "quiet", messageIds: ["z"] },
	]);
	assert.deepEqual(grouped.get("thread"), [
		{ kind: "phishing", count: 1 },
		{ kind: "reply", count: 1 },
		{ kind: "summary", count: 1 },
	]);
	assert.deepEqual(pickSuggestionBadge(grouped.get("thread")), { kind: "phishing", more: 1 });
	assert.deepEqual(grouped.get("b"), [
		{ kind: "reply", count: 1 },
		{ kind: "summary", count: 1 },
	]);
	assert.deepEqual(pickSuggestionBadge(grouped.get("b")), { kind: "reply", more: 0 });
	assert.deepEqual(grouped.get("c"), [{ kind: "reply", count: 2 }]);
	assert.equal(grouped.has("quiet"), false);
	assert.equal(groupSuggestionCounts([], [{ id: "a", messageIds: ["a"] }]).size, 0);
});
