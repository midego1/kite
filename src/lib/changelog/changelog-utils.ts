import type { ChangelogInline, ChangelogRelease, ChangelogSection } from "./types";

/** Sections without a `###` heading of their own collect here. */
const DEFAULT_SECTION_TITLE = "Changes";
const RELEASE_HEADING = /^##\s+(?:\[([^\]]+)\]|(\S.*?))(?:\s+-\s+(.+?))?\s*$/;
const SECTION_HEADING = /^###\s+(\S.*?)\s*$/;
const LIST_ITEM = /^\s*[-*]\s+(.+)$/;
const INDENTED = /^\s+\S/;
const HORIZONTAL_RULE = /^([-*_])\1{2,}$/;
const LEADING_HASHES = /^#+\s+/;

function lastSection(release: ChangelogRelease): ChangelogSection | undefined {
	return release.sections[release.sections.length - 1];
}

/** Bullets and loose paragraphs both become items, so nothing in the file is dropped. */
function appendItem(release: ChangelogRelease, text: string): void {
	const section = lastSection(release);
	if (section) section.items.push(text);
	else release.sections.push({ title: DEFAULT_SECTION_TITLE, items: [text] });
}

/** A wrapped bullet continues on the lines below it. */
function appendContinuation(release: ChangelogRelease, text: string): boolean {
	const items = lastSection(release)?.items;
	if (!items?.length) return false;
	items[items.length - 1] = `${items[items.length - 1]} ${text}`;
	return true;
}

/**
 * Turns the release headings of CHANGELOG.md into a structure the "What's new"
 * dialog can render: newest release first, each with its `###` groups and
 * bullet items. The preamble and any unrecognized line are handled without
 * losing text — an unexpected line simply becomes an item.
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
	const releases: ChangelogRelease[] = [];
	let release: ChangelogRelease | undefined;

	for (const rawLine of markdown.split(/\r?\n/)) {
		const releaseMatch = RELEASE_HEADING.exec(rawLine);
		if (releaseMatch) {
			const name = releaseMatch[1] ?? releaseMatch[2];
			release = { name, date: releaseMatch[3]?.trim() ?? null, sections: [] };
			releases.push(release);
			continue;
		}
		// Everything before the first release heading (the Keep a Changelog preamble) is not a note.
		if (!release) continue;

		const sectionMatch = SECTION_HEADING.exec(rawLine);
		if (sectionMatch) {
			release.sections.push({ title: sectionMatch[1], items: [] });
			continue;
		}

		const itemMatch = LIST_ITEM.exec(rawLine);
		if (itemMatch) {
			appendItem(release, itemMatch[1].trim());
			continue;
		}

		const text = rawLine.trim();
		if (!text || HORIZONTAL_RULE.test(text) || text.startsWith(">")) continue;
		if (INDENTED.test(rawLine) && appendContinuation(release, text)) continue;
		appendItem(release, text.replace(LEADING_HASHES, ""));
	}

	return releases;
}

/** "Unreleased changes" reads better than the raw heading in the dialog. */
export function changelogReleaseLabel(release: ChangelogRelease): string {
	return release.name === "Unreleased" ? "Unreleased changes" : release.name;
}

const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|\[([^\]]+)\]\(([^)\s]+)\)/g;
/** Only absolute http(s) links become anchors: a repository-relative path means nothing in the app. */
const SAFE_HREF = /^https?:\/\/[^\s]+$/i;

/**
 * Splits one item into text, `code`, **strong** and link pieces. The renderer
 * writes each piece as a text node, so HTML in the changelog can never become
 * markup; a link that is not plain http(s) stays literal text.
 */
export function parseInlineMarkdown(text: string): ChangelogInline[] {
	const tokens: ChangelogInline[] = [];
	let consumed = 0;

	for (const match of text.matchAll(INLINE_PATTERN)) {
		const index = match.index;
		const [full, code, strong, linkText, href] = match;
		if (index > consumed) tokens.push({ type: "text", text: text.slice(consumed, index) });
		consumed = index + full.length;
		if (code) tokens.push({ type: "code", text: code.slice(1, -1) });
		else if (strong) tokens.push({ type: "strong", text: strong.slice(2, -2) });
		else if (SAFE_HREF.test(href)) tokens.push({ type: "link", text: linkText, href });
		else tokens.push({ type: "text", text: full });
	}
	if (consumed < text.length) tokens.push({ type: "text", text: text.slice(consumed) });

	return tokens;
}
