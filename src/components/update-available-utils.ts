import type { UpdateCheckState, UpdateDecision, UpdateNoticeState, UpdateSurface } from "./update-available-types";

export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;
/** Focus and visibility changes can come in bursts; they check again only after this gap. */
const UPDATE_CHECK_MIN_GAP_MS = 60_000;
export const UPDATE_TOAST_ID = "kite-update-available";
export const UPDATE_ROW_SUBJECT = "Kite was updated";
const UPDATE_ROW_PREVIEW = "Reload to get the latest version";
export const UPDATE_TOAST_MESSAGE = "Kite was updated. Reload to get the latest version.";

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

/** The part of a deployment version worth showing: a Workers version id is a UUID, so its first block identifies it. */
function shortDeploymentVersion(version: string): string {
	const trimmed = version.trim();
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(trimmed)) return trimmed.slice(0, 8);
	const first = trimmed.split(/\s+/)[0] ?? "";
	return first.length > 16 ? first.slice(0, 16) : first;
}

/** The pinned row's second line: what to do, then which version is waiting. */
export function updateRowPreview(version: string): string {
	const short = shortDeploymentVersion(version);
	return short ? `${UPDATE_ROW_PREVIEW} · ${short}` : UPDATE_ROW_PREVIEW;
}

/**
 * Where an available update is announced: the top of a message list when one is on screen, otherwise a toast so
 * pages without a list (settings, admin, calendar, drive) still notice it. A dismissed notice stays gone.
 */
export function chooseUpdateSurface({ available, dismissed, lists }: UpdateNoticeState): UpdateSurface {
	if (!available || dismissed) return "none";
	return lists > 0 ? "row" : "toast";
}
