import path from "node:path";
import { FRAGMENT_DIRECTORY, isFragmentFile } from "./changelog-fragments.mjs";

/**
 * The pull request's labels. CI reads them live from the API (PR_NUMBER, GITHUB_TOKEN, GITHUB_REPOSITORY),
 * so rerunning the job after adding no-changelog sees the label; otherwise, or when that fails, it uses
 * the JSON in PR_LABELS from the event. Anything unreadable counts as no labels.
 */
export async function pullRequestLabels(env, fetchImpl = fetch) {
	const { PR_NUMBER, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_LABELS } = env;
	if (/^\d+$/.test(PR_NUMBER ?? "") && GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY ?? "")) {
		try {
			const response = await fetchImpl(
				`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/labels?per_page=100`,
				{ headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: "application/vnd.github+json" } },
			);
			if (response.ok) return (await response.json()).map((label) => String(label.name));
		} catch {
			// Fall back to the labels in the event.
		}
	}
	try {
		const labels = JSON.parse(PR_LABELS || "[]");
		return Array.isArray(labels) ? labels.map(String) : [];
	} catch {
		return [];
	}
}

/**
 * The commit to compare against. On a pull request (`pullRequest`) CI checks out GitHub's merge commit,
 * whose first parent is the base it was merged onto, so that parent is used even when the base passed in
 * (the event's base SHA) has moved on since; `git` runs a git command and returns its output or throws.
 * Anywhere else, such as a local branch with merges of its own, `base` is used as given.
 */
export function resolveBase(git, base, { pullRequest = false } = {}) {
	if (!pullRequest) return base;
	let parents;
	try {
		parents = git("cat-file", "-p", "HEAD")
			.split("\n")
			.filter((line) => line.startsWith("parent "))
			.map((line) => line.slice("parent ".length));
	} catch {
		return base;
	}
	if (parents.length !== 2) return base;
	const [first] = parents;
	try {
		git("cat-file", "-e", `${first}^{commit}`);
	} catch {
		try {
			git("fetch", "--no-tags", "--depth=1", "origin", first);
		} catch {
			return base;
		}
	}
	return first;
}

/** The fragments the branch adds, edits or renames compared with `base`. */
export function changedFragmentFiles(git, base) {
	return git("diff", "--name-only", "--diff-filter=AMR", base, "HEAD", "--", FRAGMENT_DIRECTORY)
		.split("\n")
		.filter((file) => file && isFragmentFile(path.basename(file)));
}
