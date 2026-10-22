import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { commitSubjects } from "../release-notes.mjs";
import { planRelease, publishRelease, releaseTag, renderPublishedNotes } from "./release-publish-utils.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const eventIndex = args.indexOf("--event");
const eventPath = eventIndex === -1 ? undefined : args[eventIndex + 1];

if (!eventPath) {
	console.error("Usage: release-publish.mjs --event <path> [--dry-run]");
	process.exit(2);
}

const git = (...gitArgs) =>
	execFileSync("git", gitArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();

function isAncestor(sha, of) {
	try {
		git("merge-base", "--is-ancestor", sha, of);
		return true;
	} catch {
		return false;
	}
}

/** The previous release tag reachable from `sha`, or the first commit when there is none. */
function previousRelease(sha) {
	try {
		return git("describe", "--tags", "--abbrev=0", "--match", "v*", `${sha}^`);
	} catch {
		return git("rev-list", "--max-parents=0", sha).split("\n").pop();
	}
}

const plan = planRelease(JSON.parse(readFileSync(eventPath, "utf8")));
if (plan.skip) {
	console.log(JSON.stringify(plan, null, 2));
	process.exit(0);
}

// The workflow checks out the default branch and runs this script from it, so a deploy is only
// released when its commit is on that branch.
if (!isAncestor(plan.sha, "HEAD")) {
	console.log(`::warning::Deployed commit ${plan.sha} is not on the default branch; no release was made.`);
	process.exit(0);
}

const version = git("show", `${plan.sha}:VERSION`).trim();
const tag = releaseTag(version);
const base = previousRelease(plan.sha);
const notes = renderPublishedNotes({
	version,
	changelog: git("show", `${plan.sha}:CHANGELOG.md`),
	base,
	subjects: commitSubjects(base, plan.sha),
});

if (dryRun) {
	console.log(JSON.stringify({ ...plan, version, tag, base }, null, 2));
	console.log(notes);
	process.exit(0);
}

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) {
	console.error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
	process.exit(2);
}

try {
	const result = await publishRelease({ sha: plan.sha, version, notes }, { fetch, token, repo });
	if (result.outcome === "not-bumped") {
		console.log(
			`::warning::This deploy did not bump VERSION: ${tag} already names ${result.taggedSha}, not ${plan.sha}. Run npm run release:prepare as the last commit of each pull request.`,
		);
	} else if (result.outcome === "already-published") {
		console.log(`${tag} is already published (${result.url}); leaving its notes untouched.`);
	} else {
		const how = result.outcome === "published-draft" ? "Published the draft" : "Published";
		console.log(`${how} ${tag}${result.createdTag ? " and created its tag" : ""}: ${result.url}`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : "publishing failed");
	process.exit(1);
}
