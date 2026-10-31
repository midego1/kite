import { compareCalendarVersions, isCalendarVersion } from "./calendar-version-utils";
import { parseInlineMarkdown } from "./changelog-utils";
import type { ChangelogRelease } from "./types";

/** A tab many releases behind still gets a short note; the full history stays in the "What's new" dialog. */
const UPDATE_NOTES_MAX_RELEASES = 3;

function hasItems(release: ChangelogRelease): boolean {
	return release.sections.some((section) => section.items.length > 0);
}

/**
 * The release notes a tab running release `have` has not had yet, newest first, at most three: the releases above
 * it and "Unreleased" when it has entries. The server keeps only its newest releases, so a calendar version older
 * than all of them (a tab left open over several releases) gets the newest three. A version newer than every kept
 * release (a server rolled back below the tab's release) or one that is not a calendar version (a development
 * build) gets none, so nothing old is ever shown as new.
 */
export function pickUpdateNotes(releases: ChangelogRelease[], have: string): ChangelogRelease[] {
	const index = releases.findIndex((release) => release.name === have);
	if (index >= 0) return releases.slice(0, index).filter(hasItems).slice(0, UPDATE_NOTES_MAX_RELEASES);
	const oldest = releases.findLast((release) => isCalendarVersion(release.name));
	if (!oldest || compareCalendarVersions(have, oldest.name) !== -1) return [];
	return releases.filter(hasItems).slice(0, UPDATE_NOTES_MAX_RELEASES);
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
