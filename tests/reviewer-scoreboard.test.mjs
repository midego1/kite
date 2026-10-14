import assert from "node:assert/strict";
import test from "node:test";
import {
	adoptionRate,
	classifyReply,
	formatScoreboard,
	tallyReviewers,
} from "../scripts/review/reviewer-scoreboard-utils.mjs";

const finding = (id, login) => ({ id, user: { login }, in_reply_to_id: null, body: "Finding." });
const answer = (id, inReplyTo, body, login = "github-actions[bot]") => ({
	id,
	user: { login },
	in_reply_to_id: inReplyTo,
	body,
});
const byReviewer = (rows) => Object.fromEntries(rows.map((row) => [row.reviewer, row]));

test("classifies the adopt workflow's answers", () => {
	assert.deepEqual(classifyReply("Adopted in 1a2b3c4."), { outcome: "adopted", sha: "1a2b3c4" });
	assert.deepEqual(classifyReply("Already addressed in 9f8e7d6."), { outcome: "alreadyAddressed" });
	assert.deepEqual(classifyReply("Already addressed in the current code."), { outcome: "alreadyAddressed" });
	assert.deepEqual(classifyReply("The listener is removed in the cleanup."), { outcome: "declined" });
});

test("tallies each reviewer's findings by outcome and counts shared adoptions", () => {
	const rows = byReviewer(
		tallyReviewers([
			{
				number: 1,
				comments: [
					finding(10, "coderabbitai[bot]"),
					finding(11, "coderabbitai[bot]"),
					finding(12, "coderabbitai[bot]"),
					finding(20, "greptile-apps[bot]"),
					finding(21, "greptile-apps[bot]"),
					answer(30, 10, "Adopted in aaaaaaa."),
					answer(31, 20, "Adopted in aaaaaaa."),
					answer(32, 11, "That path is never reached."),
					answer(33, 21, "Adopted in bbbbbbb."),
					// A human reply never counts as the workflow's verdict.
					answer(34, 12, "Adopted in ccccccc.", "a-human"),
				],
			},
			{
				number: 2,
				comments: [finding(40, "greptile-apps[bot]"), answer(41, 40, "Already addressed in the current code.")],
			},
		]),
	);
	assert.deepEqual(rows.CodeRabbit, {
		reviewer: "CodeRabbit",
		pullRequests: 1,
		findings: 3,
		adopted: 1,
		sharedAdopted: 1,
		alreadyAddressed: 0,
		declined: 1,
		open: 1,
	});
	assert.deepEqual(rows.Greptile, {
		reviewer: "Greptile",
		pullRequests: 2,
		findings: 3,
		adopted: 2,
		sharedAdopted: 1,
		alreadyAddressed: 1,
		declined: 0,
		open: 0,
	});
});

test("ignores other authors and lists every reviewer even without findings", () => {
	const rows = byReviewer(tallyReviewers([{ number: 3, comments: [finding(50, "a-human")] }]));
	assert.equal(rows.CodeRabbit.findings, 0);
	assert.equal(rows.Greptile.findings, 0);
	assert.equal(adoptionRate(rows.CodeRabbit), null);
});

test("formats a Markdown table with the adoption rate", () => {
	const table = formatScoreboard(
		[
			{
				reviewer: "Greptile",
				pullRequests: 2,
				findings: 4,
				adopted: 1,
				sharedAdopted: 0,
				alreadyAddressed: 1,
				declined: 1,
				open: 1,
			},
		],
		5,
	);
	assert.match(table, /last 5 pull request/);
	assert.match(table, /\| Greptile \| 2 \| 4 \| 1 \| 0 \| 1 \| 1 \| 1 \| 33% \|/);
});
