import { parseInlineMarkdown } from "./changelog-utils";
import type { ChangelogRelease } from "./types";

/** A tab many releases behind still gets a short note; the full history stays in the "What's new" dialog. */
export const UPDATE_NOTES_MAX_RELEASES = 3;

function hasItems(release: ChangelogRelease): boolean {
	return release.sections.some((section) => section.items.length > 0);
}

/**
 * The release notes a tab running release `have` has not had yet, newest first: the releases above it and
 * "Unreleased" when it has entries. A release this changelog does not know (a development build, or a server
 * rolled back to an older release than the tab's) gets none, so nothing old is ever shown as new.
 */
export function pickUpdateNotes(releases: ChangelogRelease[], have: string): ChangelogRelease[] {
	const index = releases.findIndex((release) => release.name === have);
	if (index < 0) return [];
	return releases.slice(0, index).filter(hasItems).slice(0, UPDATE_NOTES_MAX_RELEASES);
}

/** The first entry of the notes as plain text, for the preview line of the "Kite was updated" row. */
export function firstUpdateNoteLine(notes: ChangelogRelease[]): string {
	const item = notes.flatMap((release) => release.sections.flatMap((section) => section.items))[0];
	if (!item) return "";
	return parseInlineMarkdown(item)
		.map((token) => token.text)
		.join("")
		.trim();
}
