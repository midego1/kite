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
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADOPT_GATE_CHECKS, adoptedCommentIds, rejectedAdoptionReplies } from "./coderabbit-comments-utils.mjs";

const REPLIES_FILE = "replies.json";

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function summary(line) {
	console.log(line);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function passes(script, cwd) {
	console.log(`\n> npm run ${script} (${cwd === process.cwd() ? "with the adoptions" : "without them"})`);
	return spawnSync("npm", ["run", script], { cwd, stdio: "inherit" }).status === 0;
}

/** The checks that fail without the adoptions too, run in a worktree of the base commit. */
function failingAtBase(base, checks) {
	const directory = mkdtempSync(path.join(tmpdir(), "adopt-gate-"));
	rmSync(directory, { recursive: true });
	git("worktree", "add", "--detach", directory, base);
	try {
		symlinkSync(path.resolve("node_modules"), path.join(directory, "node_modules"), "dir");
		// The generated bundles are untracked; `check` builds them, the other checks need them.
		spawnSync("npm", ["run", "bundles"], { cwd: directory, stdio: "inherit" });
		return checks.filter((check) => !passes(check, directory));
	} finally {
		git("worktree", "remove", "--force", directory);
	}
}

function readReplies() {
	return existsSync(REPLIES_FILE) ? JSON.parse(readFileSync(REPLIES_FILE, "utf8")) : [];
}

function main() {
	const base = process.env.BASE_SHA;
	if (!base) throw new Error("BASE_SHA must be set");
	const commits = git("rev-list", `${base}..HEAD`).split("\n").filter(Boolean);
	if (commits.length === 0) {
		summary("No adoptions to check.");
		return;
	}
	const failed = ADOPT_GATE_CHECKS.filter((check) => !passes(check, process.cwd()));
	if (failed.length === 0) {
		summary(`The adoptions pass ${ADOPT_GATE_CHECKS.map((check) => `\`npm run ${check}\``).join(", ")}.`);
		return;
	}
	const preexisting = new Set(failingAtBase(base, failed));
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
