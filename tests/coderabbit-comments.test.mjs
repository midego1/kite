import assert from "node:assert/strict";
import test from "node:test";
import { selectActionableComments } from "../scripts/review/coderabbit-comments-utils.mjs";

const comment = (overrides = {}) => ({
	id: 1,
	user: { login: "coderabbitai[bot]" },
	in_reply_to_id: null,
	position: 4,
	path: "src/components/migrations-banner.tsx",
	line: 32,
	original_line: 32,
	body: "Finding.",
	...overrides,
});

test("selects the reviewer's top-level findings that still anchor to the current head", () => {
	const comments = [comment({ id: 11 }), comment({ id: 12, path: "e2e/19-updates.spec.ts", line: 12 })];
	assert.deepEqual(
		selectActionableComments(comments).map((selected) => selected.id),
		[11, 12],
	);
});

test("skips replies, other authors, outdated comments and answered threads", () => {
	const comments = [
		// A human inline comment.
		comment({ id: 21, user: { login: "human-reviewer" } }),
		// A reply inside a thread, never a starting point.
		comment({ id: 22, in_reply_to_id: 21, position: 5 }),
		// Outdated: the anchor no longer maps onto the pull request head.
		comment({ id: 23, position: null }),
		// The adopt workflow already answered this thread.
		comment({ id: 24 }),
		comment({ id: 25, user: { login: "github-actions[bot]" }, in_reply_to_id: 24, position: 5 }),
	];
	assert.deepEqual(selectActionableComments(comments), []);
});

test("keeps only the fields the prompt needs and falls back to the original line", () => {
	const comments = [comment({ id: 31, line: null, original_line: 64, body: "Long finding." })];
	assert.deepEqual(selectActionableComments(comments), [
		{ id: 31, path: "src/components/migrations-banner.tsx", line: 64, body: "Long finding." },
	]);
});

test("the workflow bot login is configurable", () => {
	const comments = [
		comment({ id: 41 }),
		comment({ id: 42, user: { login: "adopt-bot[bot]" }, in_reply_to_id: 41, position: 5 }),
	];
	assert.deepEqual(
		selectActionableComments(comments, { botLogin: "adopt-bot[bot]" }).map((selected) => selected.id),
		[],
	);
});
