import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRAGMENT_DIRECTORY, isFragmentFile, readFragments } from "./changelog-fragments.mjs";
import { checkPullRequest, isReleaseBranch } from "./version-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();

/** The labels CI passes as JSON in PR_LABELS; anything unreadable counts as no labels. */
function pullRequestLabels() {
	try {
		const labels = JSON.parse(process.env.PR_LABELS || "[]");
		return Array.isArray(labels) ? labels.map(String) : [];
	} catch {
		return [];
	}
}

// The "Changelog" pull request check (docs/releasing.md). Uses only Node built-ins, so CI can run it
// without installing dependencies. CI passes the branch in HEAD_REF and the labels in PR_LABELS;
// locally the current branch is used.
function main() {
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
		labels: pullRequestLabels(),
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

process.exitCode = main();
