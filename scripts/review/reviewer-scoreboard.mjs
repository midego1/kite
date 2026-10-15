#!/usr/bin/env node
// Compares the AI reviewers by what the adopt workflow made of their inline findings on the
// most recently updated pull requests. Reads the repository from GITHUB_REPOSITORY and the
// token from GH_TOKEN (locally: GH_TOKEN=$(gh auth token)), and prints a Markdown table.
// Usage: node scripts/review/reviewer-scoreboard.mjs [--limit 30]

import { parseArgs } from "node:util";
import { formatScoreboard, tallyReviewers } from "./reviewer-scoreboard-utils.mjs";
import { githubToken, listRecentPullRequests, listReviewComments } from "./github-api.mjs";

async function main() {
	const { values } = parseArgs({ options: { limit: { type: "string", default: "30" } } });
	const limit = Number(values.limit);
	const repository = process.env.GITHUB_REPOSITORY ?? "midego1/kite";
	const token = githubToken();
	if (!token || !Number.isInteger(limit) || limit < 1) {
		throw new Error("GH_TOKEN (or GITHUB_TOKEN) must be set and --limit must be a positive integer");
	}
	const pullRequests = [];
	for (const { number } of await listRecentPullRequests(repository, token, limit)) {
		pullRequests.push({ number, comments: await listReviewComments(repository, number, token) });
	}
	process.stdout.write(`${formatScoreboard(tallyReviewers(pullRequests), pullRequests.length)}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
