import type { UpdateCheckState, UpdateDecision } from "./update-available-types";

export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;
/** Focus and visibility changes can come in bursts; they check again only after this gap. */
const UPDATE_CHECK_MIN_GAP_MS = 60_000;
export const UPDATE_TOAST_ID = "kite-update-available";
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
