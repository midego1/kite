// Minimal GitHub REST helpers shared by the review scripts.

const PER_PAGE = 100;

export function githubToken() {
	return process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
}

async function githubGet(path, token) {
	const response = await fetch(`https://api.github.com${path}`, {
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!response.ok) throw new Error(`GitHub request ${path.split("?")[0]} failed (${response.status})`);
	return response.json();
}

/** Every review comment (inline comments and their replies) of one pull request. */
export async function listReviewComments(repository, pullRequest, token) {
	const comments = [];
	for (let page = 1; ; page += 1) {
		const batch = await githubGet(
			`/repos/${repository}/pulls/${pullRequest}/comments?per_page=${PER_PAGE}&page=${page}`,
			token,
		);
		comments.push(...batch);
		if (batch.length < PER_PAGE) break;
	}
	return comments;
}

/** The most recently updated pull requests of a repository, open and closed. */
export async function listRecentPullRequests(repository, token, limit) {
	const pullRequests = [];
	for (let page = 1; pullRequests.length < limit; page += 1) {
		const batch = await githubGet(
			`/repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`,
			token,
		);
		pullRequests.push(...batch);
		if (batch.length < PER_PAGE) break;
	}
	return pullRequests.slice(0, limit);
}
