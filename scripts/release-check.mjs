import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFragments } from "./changelog-fragments.mjs";
import { changedFragmentFiles, pullRequestLabels, resolveBase } from "./release-check-utils.mjs";
import { checkPullRequest, isReleaseBranch } from "./version-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();

// The "Release version" pull request check (docs/releasing.md). Uses only Node built-ins, so CI can run it
// without installing dependencies. CI passes the branch in HEAD_REF and the labels through PR_NUMBER or
// PR_LABELS; locally the current branch is used.
async function main() {
	const requested = process.argv[2];
	if (!requested || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(requested)) {
		console.error("Usage: release-check.mjs <base-ref>");
		return 2;
	}
	const base = resolveBase(git, requested, { pullRequest: process.env.GITHUB_EVENT_NAME === "pull_request" });
	let baseVersion;
	try {
		baseVersion = git("show", `${base}:VERSION`);
	} catch {
		console.error(`Could not read VERSION at ${base}; fetch that revision first.`);
		return 2;
	}
	const branch = process.env.HEAD_REF || git("rev-parse", "--abbrev-ref", "HEAD");
	const changedFragments = changedFragmentFiles(git, base);
	const headVersion = readFileSync(path.join(root, "VERSION"), "utf8");
	const problems = checkPullRequest({
		branch,
		labels: await pullRequestLabels(process.env),
		baseVersion,
		headVersion,
		changelog: readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
		fragments: readFragments(root),
		changedFragments,
	});
	if (!problems.length) {
		console.log(
			isReleaseBranch(branch)
				? `Release ${headVersion.trim()} follows ${baseVersion.trim()} at ${base}.`
				: changedFragments.length
					? `Changelog fragments: ${changedFragments.join(", ")}.`
					: "No changelog fragment; the pull request is labelled no-changelog.",
		);
		return 0;
	}
	console.error(problems.map((problem) => `- ${problem}`).join("\n"));
	console.error(
		`\nCompared with ${base}. A stale release pull request fails here until the release workflow refreshes it. See docs/releasing.md.`,
	);
	return 1;
}

process.exitCode = await main();
