import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { imageProblems } from "./changelog-images.mjs";

/** Where pull requests leave their changelog entries until the next release folds them into CHANGELOG.md. */
export const FRAGMENT_DIRECTORY = "changelog.d";
/** Keep a Changelog's groups, in the order a release lists them. */
export const FRAGMENT_SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
/** Explains the format; never a fragment. */
const FRAGMENT_README = "README.md";
const FRAGMENT_NAME = /^[a-z0-9][a-z0-9._-]*\.md$/;
const SECTION_HEADING = /^###[ \t]+(.+?)[ \t]*$/;
const OTHER_HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
// CHANGELOG.md's release headings; even inside a code block they would end the release they land in.
const RELEASE_LEVEL = /^##[ \t]/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
// Paragraph notes and lines such as "#123 ..." count as entries too; blank lines and headings alone do not.
export const ENTRY = /^(?![ \t]{0,3}#{1,6}(?:[ \t]|$))[ \t]*\S/m;

/** Whether `name` (a file in changelog.d) is read as a fragment. */
export function isFragmentFile(name) {
	return name.endsWith(".md") && name !== FRAGMENT_README;
}

/**
 * Splits one fragment into its `### Section` groups. A fragment holds one or more groups, each a known
 * section with at least one entry; nothing may come before the first group and no other heading level
 * is allowed, so folding it into CHANGELOG.md cannot add a release or break the one it lands in.
 */
export function parseFragment(text, name = "fragment") {
	const problems = [];
	if (!FRAGMENT_NAME.test(name)) {
		problems.push(`${name}: name it with lowercase letters, digits, ".", "_" or "-", ending in .md`);
	}
	const sections = [];
	let current = null;
	let fence = null;
	let textBefore = false;
	for (const line of String(text).split(/\r?\n/)) {
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			// Inside a code block only the closing fence and release-level headings matter.
			if (marker?.[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length)) fence = null;
			else if (RELEASE_LEVEL.test(line))
				problems.push(`${name}: "${line.trim()}" would start a new release, even in a code block`);
		} else if (marker) {
			fence = marker;
		}
		const heading = !fence && !marker ? SECTION_HEADING.exec(line) : null;
		if (heading) {
			if (!FRAGMENT_SECTIONS.includes(heading[1])) {
				problems.push(`${name}: "### ${heading[1]}" is not one of ${FRAGMENT_SECTIONS.join(", ")}`);
			}
			current = { title: heading[1], lines: [] };
			sections.push(current);
		} else if (!fence && !marker && OTHER_HEADING.test(line)) {
			problems.push(`${name}: only "### Section" headings are allowed, found "${line.trim()}"`);
		} else if (current) {
			current.lines.push(line);
		} else if (line.trim() && !textBefore) {
			textBefore = true;
			problems.push(`${name}: text before the first "### Section" heading`);
		}
	}
	if (fence) problems.push(`${name}: a code block opened with ${fence} is never closed`);
	if (!sections.length) problems.push(`${name}: add a "### Section" heading (${FRAGMENT_SECTIONS.join(", ")})`);
	const groups = sections.map(({ title, lines }) => ({ title, body: lines.join("\n").trim() }));
	for (const group of groups) {
		if (!ENTRY.test(group.body)) problems.push(`${name}: "### ${group.title}" has no entries`);
	}
	return { sections: groups.filter((group) => ENTRY.test(group.body)), problems };
}

/**
 * Every problem in a list of `{ name, text }` fragments. Screenshots are always checked for alt text and a
 * /changelog/ path; with `root` their files are checked too (exist, WebP, size).
 */
export function fragmentProblems(fragments, { root } = {}) {
	return fragments.flatMap((fragment) => [
		...parseFragment(fragment.text, fragment.name).problems,
		...imageProblems(fragment.text, fragment.name, root),
	]);
}

/**
 * The markdown of a release built from fragments: one `### Section` per group in Keep a Changelog
 * order, each fragment's entries in the order the fragments are given. Groups of invalid fragments are
 * still used when they parse; `fragmentProblems` is what refuses them.
 */
export function foldFragments(fragments) {
	const bySection = new Map(FRAGMENT_SECTIONS.map((title) => [title, []]));
	for (const fragment of fragments) {
		for (const section of parseFragment(fragment.text, fragment.name).sections) {
			bySection.get(section.title)?.push(section.body);
		}
	}
	return [...bySection]
		.filter(([, bodies]) => bodies.length)
		.map(([title, bodies]) => `### ${title}\n\n${bodies.join("\n")}`)
		.join("\n\n");
}

/** The fragments in `root`/changelog.d, sorted by name so every run folds them the same way. */
export function readFragments(root) {
	const directory = path.join(root, FRAGMENT_DIRECTORY);
	let names;
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	return names
		.filter(isFragmentFile)
		.sort()
		.map((name) => ({
			name,
			path: path.join(directory, name),
			text: readFileSync(path.join(directory, name), "utf8"),
		}));
}

/**
 * The entries of a release: whatever is still under "Unreleased" in CHANGELOG.md (pull requests made
 * before fragments existed) merged with the fragments, so each `### Section` appears once. An Unreleased
 * body that is not in fragment form is kept as it is, above the fragments.
 */
export function foldUnreleased(unreleasedBody, fragments) {
	const existing = String(unreleasedBody).trim();
	if (!existing || !ENTRY.test(existing)) return foldFragments(fragments);
	if (!parseFragment(existing, "unreleased.md").problems.length) {
		return foldFragments([{ name: "unreleased.md", text: existing }, ...fragments]);
	}
	const folded = foldFragments(fragments);
	return folded ? `${existing}\n\n${folded}` : existing;
}
