import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyReply,
	formatScoreboard,
	tallyReviewers,
	validRate,
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
	assert.deepEqual(classifyReply("Already addressed in 9f8e7d6."), { outcome: "alreadyAddressed", sha: "9f8e7d6" });
	assert.deepEqual(classifyReply("Already addressed in the current code."), { outcome: "alreadyAddressed" });
	assert.deepEqual(classifyReply("Valid, not adopted: the fix broke the e2e suite."), {
		outcome: "validNotAdopted",
	});
	assert.deepEqual(classifyReply("The listener is removed in the cleanup."), { outcome: "declined" });
});

test("credits a later finding answered with a commit the workflow adopted for another finding", () => {
	const rows = byReviewer(
		tallyReviewers([
			{
				number: 5,
				comments: [
					finding(60, "coderabbitai[bot]"),
					finding(61, "greptile-apps[bot]"),
					finding(62, "greptile-apps[bot]"),
					answer(70, 60, "Adopted in abcdef1."),
					answer(71, 61, "Already addressed in abcdef1234."),
					// A commit the workflow did not adopt stays an ordinary "already addressed".
					answer(72, 62, "Already addressed in 1234567."),
				],
			},
		]),
	);
	assert.equal(rows.CodeRabbit.adopted, 1);
	assert.equal(rows.CodeRabbit.sharedAdopted, 1);
	assert.equal(rows.Greptile.adopted, 1);
	assert.equal(rows.Greptile.sharedAdopted, 1);
	assert.equal(rows.Greptile.alreadyAddressed, 1);
});

test("counts a correct finding that failed validation as valid, not declined", () => {
	const rows = byReviewer(
		tallyReviewers([
			{
				number: 6,
				comments: [
					finding(80, "greptile-apps[bot]"),
					finding(81, "greptile-apps[bot]"),
					answer(82, 80, "Valid, not adopted: the fix failed npm run check."),
					answer(83, 81, "That branch is unreachable."),
				],
			},
		]),
	);
	assert.equal(rows.Greptile.validNotAdopted, 1);
	assert.equal(rows.Greptile.declined, 1);
	assert.equal(validRate(rows.Greptile), 0.5);
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
		validNotAdopted: 0,
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
		validNotAdopted: 0,
		declined: 0,
		open: 0,
	});
});

test("ignores other authors and lists every reviewer even without findings", () => {
	const rows = byReviewer(tallyReviewers([{ number: 3, comments: [finding(50, "a-human")] }]));
	assert.equal(rows.CodeRabbit.findings, 0);
	assert.equal(rows.Greptile.findings, 0);
	assert.equal(validRate(rows.CodeRabbit), null);
});

test("formats a Markdown table with the valid rate", () => {
	const table = formatScoreboard(
		[
			{
				reviewer: "Greptile",
				pullRequests: 2,
				findings: 5,
				adopted: 1,
				sharedAdopted: 0,
				alreadyAddressed: 1,
				validNotAdopted: 1,
				declined: 1,
				open: 1,
			},
		],
		5,
	);
	assert.match(table, /last 5 pull request/);
	assert.match(table, /\| Greptile \| 2 \| 5 \| 1 \| 0 \| 1 \| 1 \| 1 \| 1 \| 50% \|/);
});
