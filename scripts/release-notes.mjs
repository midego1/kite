import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SECTIONS = [
	["Features", /^feat(?:\(|:)/],
	["Fixes", /^fix(?:\(|:)/],
	["Maintenance", /^(?!feat(?:\(|:)|fix(?:\(|:))/],
];

/** Commit subjects grouped as Features, Fixes and Maintenance under headings at `level` (`##` by default). */
export function renderCommitGroups(subjects, level = "##") {
	const lines = [];
	for (const [heading, match] of SECTIONS) {
		const selected = subjects.filter((subject) => match.test(subject));
		if (selected.length) lines.push(`${level} ${heading}\n\n${selected.map((subject) => `- ${subject}`).join("\n")}\n`);
	}
	if (!subjects.length) lines.push("No new commits in this comparison.");
	return lines.join("\n");
}

export function renderReleaseNotes({ version, base, subjects }) {
	return `# Changes for ${version}\n\nCompared with ${base}. Review before publishing.\n\n${renderCommitGroups(subjects)}\n`;
}

/** Subjects of the non-merge commits in `base..head`, oldest last as `git log` lists them. */
export function commitSubjects(base, head = "HEAD") {
	return execFileSync("git", ["log", "--no-merges", "--format=%s", `${base}..${head}`], { encoding: "utf8" })
		.trim()
		.split("\n")
		.filter(Boolean);
}

// Generate reviewable notes from an explicit, verified comparison ref.
function main() {
	const base = process.argv[2] ?? "origin/main";
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base)) throw new Error("Invalid base revision");
	const revision = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { encoding: "utf8" }).trim();
	const version = readFileSync("VERSION", "utf8").trim();
	process.stdout.write(renderReleaseNotes({ version, base, subjects: commitSubjects(revision) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
