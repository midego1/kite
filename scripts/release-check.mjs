import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRAGMENT_DIRECTORY, isFragmentFile, readFragments } from "./changelog-fragments.mjs";
import { checkPullRequest, isReleaseBranch } from "./version-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();

/**
 * The pull request's labels. CI reads them live from the API (PR_NUMBER, GITHUB_TOKEN, GITHUB_REPOSITORY),
 * so rerunning the job after adding no-changelog sees the label; otherwise, or when that fails, it uses
 * the JSON in PR_LABELS from the event. Anything unreadable counts as no labels.
 */
async function pullRequestLabels() {
	const { PR_NUMBER, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_LABELS } = process.env;
	if (PR_NUMBER && GITHUB_TOKEN && GITHUB_REPOSITORY) {
		try {
			const response = await fetch(
				`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${encodeURIComponent(PR_NUMBER)}/labels?per_page=100`,
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

// The "Release version" pull request check (docs/releasing.md). Uses only Node built-ins, so CI can run it
// without installing dependencies. CI passes the branch in HEAD_REF and the labels in PR_LABELS;
// locally the current branch is used.
async function main() {
	const base = process.argv[2];
	if (!base || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base)) {
		console.error("Usage: release-check.mjs <base-ref>");
		return 2;
	}
	let baseVersion;
	try {
		baseVersion = git("show", `${base}:VERSION`);
	} catch {
		console.error(`Could not read VERSION at ${base}; fetch that revision first.`);
		return 2;
	}
	const branch = process.env.HEAD_REF || git("rev-parse", "--abbrev-ref", "HEAD");
	const changedFragments = git("diff", "--name-only", "--diff-filter=AMR", base, "HEAD", "--", FRAGMENT_DIRECTORY)
		.split("\n")
		.filter((file) => file && isFragmentFile(path.basename(file)));
	const problems = checkPullRequest({
		branch,
		labels: await pullRequestLabels(),
		baseVersion,
		headVersion: readFileSync(path.join(root, "VERSION"), "utf8"),
		changelog: readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
		fragments: readFragments(root),
		changedFragments,
	});
	if (!problems.length) {
		console.log(
			isReleaseBranch(branch)
				? `Release ${readFileSync(path.join(root, "VERSION"), "utf8").trim()} follows ${baseVersion.trim()} at ${base}.`
				: changedFragments.length
					? `Changelog fragments: ${changedFragments.join(", ")}.`
					: "No changelog fragment; the pull request is labelled no-changelog.",
		);
		return 0;
	}
	console.error(problems.map((problem) => `- ${problem}`).join("\n"));
	console.error("\nSee docs/releasing.md.");
	return 1;
}

process.exitCode = await main();
