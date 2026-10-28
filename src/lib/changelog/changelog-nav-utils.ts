import type { ChangelogRelease } from "./types";

/** Sections beyond this many are drawn only once they come near the viewport. */
export const EAGER_RELEASE_COUNT = 4;

/** Rough heights of an undrawn release, so the scrollbar keeps a believable length. */
const SECTION_HEADER_HEIGHT = 56;
const SECTION_TITLE_HEIGHT = 28;
const ITEM_HEIGHT = 44;

/** A stable DOM id for a release heading, e.g. `release-2026-10-28-0` or `release-unreleased`. */
export function releaseAnchorId(release: Pick<ChangelogRelease, "name">): string {
	const slug = release.name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `release-${slug || "notes"}`;
}

/** "Current" marks the release that matches the running build's version. */
export function isCurrentRelease(release: Pick<ChangelogRelease, "name">, buildVersion: string): boolean {
	return release.name !== "Unreleased" && release.name === buildVersion;
}

/**
 * Where the dialog opens: changes already deployed but not yet in a named release come
 * first, because they are newer than the running version; otherwise the current release,
 * otherwise the newest one.
 */
export function initialReleaseName(releases: ChangelogRelease[], buildVersion: string): string | null {
	const unreleased = releases.find((release) => release.name === "Unreleased");
	if (unreleased && unreleased.sections.some((section) => section.items.length > 0)) return unreleased.name;
	return (releases.find((release) => isCurrentRelease(release, buildVersion)) ?? releases[0])?.name ?? null;
}

/** An empty "Unreleased" heading has nothing to show, so the sidebar does not list it. */
export function visibleReleases(releases: ChangelogRelease[]): ChangelogRelease[] {
	return releases.filter(
		(release) => release.name !== "Unreleased" || release.sections.some((section) => section.items.length > 0),
	);
}

export function estimateReleaseHeight(release: ChangelogRelease): number {
	return release.sections.reduce(
		(height, section) => height + SECTION_TITLE_HEIGHT + section.items.length * ITEM_HEIGHT,
		SECTION_HEADER_HEIGHT,
	);
}

/** The list's own arrow-key model: Up and Down step, Home and End jump, nothing wraps. */
export function nextNavIndex(key: string, index: number, count: number): number | null {
	if (count <= 0) return null;
	if (key === "ArrowDown") return Math.min(index + 1, count - 1);
	if (key === "ArrowUp") return Math.max(index - 1, 0);
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	return null;
}

/** The topmost release that overlaps the reading band, falling back to the last one that was active. */
export function pickActiveRelease(
	order: string[],
	intersecting: ReadonlySet<string>,
	previous: string | null,
): string | null {
	return order.find((name) => intersecting.has(name)) ?? previous;
}
