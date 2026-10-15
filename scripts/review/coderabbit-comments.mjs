#!/usr/bin/env node
// Collects the CodeRabbit and Greptile review comments of one pull request that the adopt
// workflow still has to decide about (.github/workflows/coderabbit-adopt.yml). Reads the pull
// request number from PR_NUMBER, the repository from GITHUB_REPOSITORY and the token from
// GH_TOKEN, and prints JSON: { pullRequest, comments: [{ id, reviewer, path, line, body }] }.

import { selectActionableComments } from "./coderabbit-comments-utils.mjs";
import { githubToken, listReviewComments } from "./github-api.mjs";

function requiredEnvironment() {
	const repository = process.env.GITHUB_REPOSITORY;
	const pullRequest = Number(process.env.PR_NUMBER);
	const token = githubToken();
	if (!repository || !Number.isInteger(pullRequest) || pullRequest < 1 || !token) {
		throw new Error("GITHUB_REPOSITORY, PR_NUMBER and GH_TOKEN (or GITHUB_TOKEN) must be set");
	}
	return { repository, pullRequest, token };
}

async function main() {
	const { repository, pullRequest, token } = requiredEnvironment();
	const comments = await listReviewComments(repository, pullRequest, token);
	const output = { pullRequest, comments: selectActionableComments(comments) };
	process.stdout.write(`${JSON.stringify(output, null, "\t")}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
