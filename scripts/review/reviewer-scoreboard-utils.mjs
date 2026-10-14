// Pure helpers for scripts/review/reviewer-scoreboard.mjs, split out so the unit tests can
// cover the tally without talking to the GitHub API.

import { ADOPT_BOT_LOGIN, REVIEWERS } from "./coderabbit-comments-utils.mjs";

/**
 * Reads the adopt workflow's answer on a finding: "Adopted in <sha>." for a commit, "Already
 * addressed ..." when the code had it, and anything else is a reason the finding was wrong.
 */
export function classifyReply(body) {
	const adopted = /^Adopted in ([0-9a-f]{7,40})\b/.exec(body ?? "");
	if (adopted) return { outcome: "adopted", sha: adopted[1] };
	if (/^Already addressed\b/.test(body ?? "")) return { outcome: "alreadyAddressed" };
	return { outcome: "declined" };
}

function emptyRow(reviewer) {
	return {
		reviewer,
		pullRequests: 0,
		findings: 0,
		adopted: 0,
		sharedAdopted: 0,
		alreadyAddressed: 0,
		declined: 0,
		open: 0,
	};
}

/** The outcome of each reviewer's top-level findings on one pull request. */
function findingOutcomes(comments, reviewers, botLogin) {
	const answers = new Map();
	for (const comment of comments) {
		if (comment.in_reply_to_id == null || comment.user?.login !== botLogin) continue;
		if (!answers.has(comment.in_reply_to_id)) answers.set(comment.in_reply_to_id, classifyReply(comment.body));
	}
	return comments
		.filter((comment) => comment.in_reply_to_id == null && Object.hasOwn(reviewers, comment.user?.login ?? ""))
		.map((comment) => ({
			reviewer: reviewers[comment.user.login],
			...(answers.get(comment.id) ?? { outcome: "open" }),
		}));
}

/**
 * Tallies the adopt workflow's verdicts per reviewer over several pull requests. A finding
 * adopted by the same commit as another reviewer's finding counts as shared, which is what
 * separates a reviewer that finds problems the other misses from one that repeats it.
 * `pullRequests` is a list of `{ number, comments }` with the raw GitHub review comments.
 */
export function tallyReviewers(pullRequests, options = {}) {
	const reviewers = options.reviewers ?? REVIEWERS;
	const botLogin = options.botLogin ?? ADOPT_BOT_LOGIN;
	const rows = new Map(Object.values(reviewers).map((reviewer) => [reviewer, emptyRow(reviewer)]));
	for (const { comments } of pullRequests) {
		const outcomes = findingOutcomes(comments, reviewers, botLogin);
		const adoptersBySha = new Map();
		for (const { reviewer, outcome, sha } of outcomes) {
			if (outcome !== "adopted") continue;
			adoptersBySha.set(sha, new Set([...(adoptersBySha.get(sha) ?? []), reviewer]));
		}
		for (const reviewer of new Set(outcomes.map((finding) => finding.reviewer))) rows.get(reviewer).pullRequests += 1;
		for (const { reviewer, outcome, sha } of outcomes) {
			const row = rows.get(reviewer);
			row.findings += 1;
			row[outcome] += 1;
			if (outcome === "adopted" && adoptersBySha.get(sha).size > 1) row.sharedAdopted += 1;
		}
	}
	return [...rows.values()];
}

/** Share of handled findings that held up, or null before any was handled. */
export function adoptionRate(row) {
	const handled = row.adopted + row.alreadyAddressed + row.declined;
	return handled === 0 ? null : row.adopted / handled;
}

export function formatScoreboard(rows, pullRequestCount) {
	const header = [
		"| Reviewer | PRs with findings | Findings | Adopted | Shared | Already addressed | Declined | Open | Adoption rate |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	const lines = rows.map((row) => {
		const rate = adoptionRate(row);
		const cells = [
			row.reviewer,
			row.pullRequests,
			row.findings,
			row.adopted,
			row.sharedAdopted,
			row.alreadyAddressed,
			row.declined,
			row.open,
			rate === null ? "-" : `${Math.round(rate * 100)}%`,
		];
		return `| ${cells.join(" | ")} |`;
	});
	return [`Inline findings on the last ${pullRequestCount} pull request(s):`, "", ...header, ...lines].join("\n");
}
