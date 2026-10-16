import assert from "node:assert/strict";
import test from "node:test";
import {
	adoptedCommentIds,
	rejectedAdoptionReplies,
	selectActionableComments,
} from "../scripts/review/coderabbit-comments-utils.mjs";
import {
	answerAdoptions,
	touchesWorkflowFiles,
	WORKFLOW_CHANGE_REPLY,
} from "../scripts/review/coderabbit-comments-utils.mjs";

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
		{ id: 31, reviewer: "CodeRabbit", path: "src/components/migrations-banner.tsx", line: 64, body: "Long finding." },
	]);
});

test("selects Greptile's findings too and names the reviewer of each", () => {
	const comments = [
		comment({ id: 51 }),
		comment({ id: 52, user: { login: "greptile-apps[bot]" } }),
		comment({ id: 53, user: { login: "greptile-apps[bot]" }, in_reply_to_id: 51, position: 5 }),
	];
	assert.deepEqual(
		selectActionableComments(comments).map(({ id, reviewer }) => ({ id, reviewer })),
		[
			{ id: 51, reviewer: "CodeRabbit" },
			{ id: 52, reviewer: "Greptile" },
		],
	);
});

test("the reviewer list is configurable", () => {
	const comments = [comment({ id: 61 }), comment({ id: 62, user: { login: "greptile-apps[bot]" } })];
	assert.deepEqual(
		selectActionableComments(comments, { reviewers: { "greptile-apps[bot]": "Greptile" } }).map(
			(selected) => selected.id,
		),
		[62],
	);
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

test("reads the adopted comment ids from the commits' Addresses lines", () => {
	const messages = [
		"fix: escape the label\n\nAddresses CodeRabbit review comment 301 on pull request 9.\nAddresses Greptile review comment 302 on pull request 9.\n\nCo-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>",
		"test: cover the empty list\n\nAddresses Greptile review comment 205 on pull request 9.",
		"chore: format\n\nAddresses CodeRabbit review comment 301 on pull request 9.",
		"fix: unrelated\n\nAddresses Someone review comment 999 on pull request 9.",
	];
	assert.deepEqual(adoptedCommentIds(messages), [205, 301, 302]);
	assert.deepEqual(adoptedCommentIds([]), []);
});

test("answers dropped adoptions as valid, not adopted and keeps Droid's own answers", () => {
	const replies = [
		{ commentId: 7, body: "The listener is removed in the cleanup." },
		{ commentId: 8, body: "Valid, not adopted: the e2e spec could not be fixed." },
	];
	assert.deepEqual(rejectedAdoptionReplies([8, 9, 10], ["test:coverage", "quality:check"], replies), [
		...replies,
		{
			commentId: 9,
			body: "Valid, not adopted: the fix failed `npm run test:coverage`, `npm run quality:check` in the workflow's checks, which pass without it, so it was not pushed.",
		},
		{
			commentId: 10,
			body: "Valid, not adopted: the fix failed `npm run test:coverage`, `npm run quality:check` in the workflow's checks, which pass without it, so it was not pushed.",
		},
	]);
	assert.deepEqual(rejectedAdoptionReplies([], ["check"]), []);
});

test("recognises commits that change a workflow file", () => {
	assert.equal(touchesWorkflowFiles(["scripts/review/adopt-gate.mjs", ".github/workflows/ci.yml"]), true);
	assert.equal(touchesWorkflowFiles([".github/dependabot.yml", "docs/quality.md"]), false);
	assert.equal(touchesWorkflowFiles([]), false);
});

test("answers adoptions with a given reply and keeps existing answers", () => {
	const replies = [{ commentId: 3, body: "Already addressed in the current code." }];
	assert.deepEqual(answerAdoptions([3, 4], WORKFLOW_CHANGE_REPLY, replies), [
		...replies,
		{ commentId: 4, body: WORKFLOW_CHANGE_REPLY },
	]);
	assert.match(WORKFLOW_CHANGE_REPLY, /^Valid, not adopted: /);
});
