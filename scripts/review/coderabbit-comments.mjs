#!/usr/bin/env node
// Collects the CodeRabbit review comments of one pull request that the adopt workflow
// still has to decide about (.github/workflows/coderabbit-adopt.yml). Reads the pull request
// number from PR_NUMBER, the repository from GITHUB_REPOSITORY and the token from GH_TOKEN,
// and prints JSON: { pullRequest, comments: [{ id, path, line, body }] }.

import { selectActionableComments } from "./coderabbit-comments-utils.mjs";

const PER_PAGE = 100;

function requiredEnvironment() {
	const repository = process.env.GITHUB_REPOSITORY;
	const pullRequest = Number(process.env.PR_NUMBER);
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	if (!repository || !Number.isInteger(pullRequest) || pullRequest < 1 || !token) {
		throw new Error("GITHUB_REPOSITORY, PR_NUMBER and GH_TOKEN (or GITHUB_TOKEN) must be set");
	}
	return { repository, pullRequest, token };
}

async function fetchReviewComments(repository, pullRequest, token, page) {
	const response = await fetch(
		`https://api.github.com/repos/${repository}/pulls/${pullRequest}/comments?per_page=${PER_PAGE}&page=${page}`,
		{
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"x-github-api-version": "2022-11-28",
			},
		},
	);
	if (!response.ok) throw new Error(`Review comments request failed (${response.status})`);
	return response.json();
}

async function main() {
	const { repository, pullRequest, token } = requiredEnvironment();
	const comments = [];
	for (let page = 1; ; page += 1) {
		const batch = await fetchReviewComments(repository, pullRequest, token, page);
		comments.push(...batch);
		if (batch.length < PER_PAGE) break;
	}
	const output = { pullRequest, comments: selectActionableComments(comments) };
	process.stdout.write(`${JSON.stringify(output, null, "\t")}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
