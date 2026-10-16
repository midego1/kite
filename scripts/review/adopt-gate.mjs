#!/usr/bin/env node
// Runs the CI gate on the commits Droid made in an adopt run (.github/workflows/coderabbit-adopt.yml)
// before they are packed for the publish job. A check that fails with the adoptions but passes
// on the pull request head without them drops every adoption: the branch is reset to BASE_SHA
// and each adopted comment is answered `Valid, not adopted` in replies.json instead. A check
// that already failed before this run is reported and does not block the adoptions.
//
// Reads BASE_SHA (the pull request head the run started from) and, when set,
// GITHUB_STEP_SUMMARY. Run it from the repository root.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADOPT_GATE_CHECKS, adoptedCommentIds, rejectedAdoptionReplies } from "./coderabbit-comments-utils.mjs";
import { answerAdoptions, touchesWorkflowFiles, WORKFLOW_CHANGE_REPLY } from "./coderabbit-comments-utils.mjs";

const REPLIES_FILE = "replies.json";

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function summary(line) {
	console.log(line);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function passes(script, cwd, label) {
	console.log(`\n> npm run ${script} (${label})`);
	return spawnSync("npm", ["run", script], { cwd, stdio: "inherit" }).status === 0;
}

/** Checks only committed files, with that commit's dependencies, leaving Droid's files alone. */
function failingAtCommit(ref, checks, label) {
	const directory = mkdtempSync(path.join(tmpdir(), "adopt-gate-"));
	rmSync(directory, { recursive: true });
	git("worktree", "add", "--detach", directory, ref);
	try {
		if (spawnSync("npm", ["ci"], { cwd: directory, stdio: "inherit" }).status !== 0) {
			throw new Error(`Could not install dependencies for ${ref}; the comparison is unavailable.`);
		}
		// The generated bundles are untracked; `check` builds them, the other checks need them.
		spawnSync("npm", ["run", "bundles"], { cwd: directory, stdio: "inherit" });
		return checks.filter((check) => !passes(check, directory, label));
	} finally {
		git("worktree", "remove", "--force", directory);
	}
}

function readReplies() {
	return existsSync(REPLIES_FILE) ? JSON.parse(readFileSync(REPLIES_FILE, "utf8")) : [];
}

function changedFiles(sha) {
	return git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).split("\n").filter(Boolean);
}

/**
 * Replays the commits (newest first, as rev-list lists them) onto the base without those that
 * change a workflow file, or that no longer apply once those are gone, answers the comments
 * only they adopted, and returns the commits that remain, newest first.
 */
function withoutWorkflowChanges(base, commits) {
	const message = (sha) => git("log", "-1", "--format=%B", sha);
	const dropped = [];
	git("reset", "--hard", base);
	for (const sha of [...commits].reverse()) {
		if (touchesWorkflowFiles(changedFiles(sha))) {
			dropped.push(sha);
			continue;
		}
		if (spawnSync("git", ["cherry-pick", "--allow-empty", sha], { stdio: "inherit" }).status !== 0) {
			spawnSync("git", ["cherry-pick", "--abort"], { stdio: "inherit" });
			dropped.push(sha);
		}
	}
	const remaining = git("rev-list", `${base}..HEAD`).split("\n").filter(Boolean);
	const kept = new Set(adoptedCommentIds(remaining.map(message)));
	const ids = adoptedCommentIds(dropped.map(message)).filter((id) => !kept.has(id));
	writeFileSync(
		REPLIES_FILE,
		`${JSON.stringify(answerAdoptions(ids, WORKFLOW_CHANGE_REPLY, readReplies()), null, "\t")}\n`,
	);
	summary(
		`Left out ${dropped.length} commit(s) that change a workflow file or build on one; answered as valid, not adopted: ${ids.join(", ") || "no comment named"}.`,
	);
	return remaining;
}

function main() {
	const base = process.env.BASE_SHA;
	if (!base) throw new Error("BASE_SHA must be set");
	let commits = git("rev-list", `${base}..HEAD`).split("\n").filter(Boolean);
	if (commits.some((sha) => touchesWorkflowFiles(changedFiles(sha)))) {
		commits = withoutWorkflowChanges(base, commits);
	}
	if (commits.length === 0) {
		summary("No adoptions to check.");
		return;
	}
	const failed = failingAtCommit("HEAD", ADOPT_GATE_CHECKS, "with the adoptions");
	if (failed.length === 0) {
		summary(`The adoptions pass ${ADOPT_GATE_CHECKS.map((check) => `\`npm run ${check}\``).join(", ")}.`);
		return;
	}
	const preexisting = new Set(failingAtCommit(base, failed, "without them"));
	const introduced = failed.filter((check) => !preexisting.has(check));
	if (preexisting.size > 0) {
		summary(`Already failing before this run, so not held against the adoptions: ${[...preexisting].join(", ")}.`);
	}
	if (introduced.length === 0) return;

	const ids = adoptedCommentIds(commits.map((sha) => git("log", "-1", "--format=%B", sha)));
	writeFileSync(
		REPLIES_FILE,
		`${JSON.stringify(rejectedAdoptionReplies(ids, introduced, readReplies()), null, "\t")}\n`,
	);
	git("reset", "--hard", base);
	summary(
		`Dropped ${commits.length} adoption commit(s) because they break ${introduced.join(", ")} (passing without them). ` +
			`Answered as valid, not adopted: ${ids.join(", ") || "no comment named"}.`,
	);
}

main();
