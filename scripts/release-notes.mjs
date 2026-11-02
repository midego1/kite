import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { absoluteImageUrls } from "./changelog-images.mjs";
import { changelogSection, isCalendarVersion } from "./version-utils.mjs";

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
	// `npm run release:notes -- <version>` prints that version's CHANGELOG.md section as the GitHub release shows
	// it, with screenshot paths rewritten to absolute URLs; anything else is a base revision for the commit list.
	if (isCalendarVersion(process.argv[2] ?? "")) {
		const section = changelogSection(readFileSync("CHANGELOG.md", "utf8"), process.argv[2]);
		if (section === null) throw new Error(`CHANGELOG.md has no "## [${process.argv[2]}]" heading`);
		process.stdout.write(`${absoluteImageUrls(section)}\n`);
		return;
	}
	const base = process.argv[2] ?? "origin/main";
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base)) throw new Error("Invalid base revision");
	const revision = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { encoding: "utf8" }).trim();
	const version = readFileSync("VERSION", "utf8").trim();
	process.stdout.write(renderReleaseNotes({ version, base, subjects: commitSubjects(revision) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
