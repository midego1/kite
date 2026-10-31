import { compareCalendarVersions } from "@/lib/changelog/calendar-version-utils";
import type { ChangelogRelease, ChangelogSection } from "@/lib/changelog/types";
import type {
	UpdateCheckState,
	UpdateDecision,
	UpdateDetails,
	UpdateNoticeState,
	UpdateSurface,
} from "./update-available-types";

export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;
/** Focus and visibility changes can come in bursts; they check again only after this gap. */
const UPDATE_CHECK_MIN_GAP_MS = 60_000;
export const UPDATE_TOAST_ID = "kite-update-available";
const UPDATE_ROW_SUBJECT = "Kite was updated";
const UPDATE_ROW_PREVIEW = "Reload to get the latest version";
/** Read out once by the host when the notice is the list row, which has no live region of its own. */
export const UPDATE_ROW_ANNOUNCEMENT = "A new version of Kite is available.";
export const UPDATE_TOAST_MESSAGE = "Kite was updated. Reload to get the latest version.";
export const NO_UPDATE_DETAILS: UpdateDetails = { release: null, notes: [], summary: "" };

const MAX_NOTE_RELEASES = 3;
const MAX_NOTE_TEXT = 2_000;

function text(value: unknown, max = MAX_NOTE_TEXT): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function list(value: unknown, max: number): unknown[] {
	return Array.isArray(value) ? value.slice(0, max) : [];
}

function parseSection(value: unknown): ChangelogSection {
	const { title, items } = (value ?? {}) as Record<string, unknown>;
	return {
		title: text(title, 80),
		items: list(items, 40)
			.map((item) => text(item))
			.filter(Boolean),
	};
}

function parseRelease(value: unknown): ChangelogRelease {
	const { name, date, sections } = (value ?? {}) as Record<string, unknown>;
	const kept = list(sections, 8)
		.map(parseSection)
		.filter((section) => section.title && section.items.length > 0);
	return { name: text(name, 80), date: text(date, 40) || null, sections: kept };
}

/**
 * Reads the release, notes and summary a server sends with a changed version. The release counts only when it is
 * a calendar version newer than the one this tab runs (a rolled-back server is not "ready"); anything malformed is
 * left out rather than shown.
 */
export function parseUpdateDetails(value: unknown, ownRelease: string): UpdateDetails {
	const { release, notes, summary } = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
	const name = text(release, 40);
	return {
		release: compareCalendarVersions(name, ownRelease) === 1 ? name : null,
		notes: list(notes, MAX_NOTE_RELEASES)
			.map(parseRelease)
			.filter((entry) => entry.name && entry.sections.length > 0),
		summary: text(summary, 200),
	};
}

/** "Kite 2026.10.31.4 is ready" when the new release is known, otherwise "Kite was updated". */
export function updateSubject({ release }: UpdateDetails): string {
	return release ? `Kite ${release} is ready` : UPDATE_ROW_SUBJECT;
}

/** The row's preview: the call to reload, then the first line of what's new when the server sent notes. */
export function updatePreview({ summary }: UpdateDetails): string {
	return summary ? `${UPDATE_ROW_PREVIEW} · ${summary}` : UPDATE_ROW_PREVIEW;
}

/** Reads `{ version }`; anything else is an unknown version. */
export function parseDeploymentVersion(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const version = (value as Record<string, unknown>).version;
	return typeof version === "string" ? version.trim() : "";
}

/** A hidden tab never checks, and only one request runs at a time. */
export function shouldCheckForUpdate({ now, lastCheckAt, visible, inFlight }: UpdateCheckState): boolean {
	if (!visible || inFlight) return false;
	return lastCheckAt === null || now - lastCheckAt >= UPDATE_CHECK_MIN_GAP_MS;
}

/**
 * The first known version is the one this tab runs. A later, different one means
 * a new deployment is live; an unknown answer never counts as a change.
 */
export function compareDeploymentVersion(known: string, latest: string): UpdateDecision {
	if (!latest) return { known, changed: false };
	if (!known) return { known: latest, changed: false };
	return { known, changed: latest !== known };
}

/**
 * Where an available update is announced: the top of a message list when one is on screen, otherwise a toast so
 * pages without a list (settings, admin, calendar, drive) still notice it. A dismissed notice stays gone.
 */
export function chooseUpdateSurface({ available, dismissed, lists, reloading }: UpdateNoticeState): UpdateSurface {
	if (!available || dismissed || reloading) return "none";
	return lists > 0 ? "row" : "toast";
}

/** "What's new" shows in the reader while it was opened from the row and the notice still stands. */
export function isUpdateReaderOpen({ available, dismissed, reloading, open }: UpdateNoticeState): boolean {
	return open && available && !dismissed && !reloading;
}
