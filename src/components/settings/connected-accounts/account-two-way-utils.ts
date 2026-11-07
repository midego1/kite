import { authFetch } from "@/lib/auth/client";
import type { ProviderSupport, TwoWaySettings, TwoWayView } from "@/lib/external-accounts/two-way-types";
import { readJson } from "./connected-accounts-utils";

function twoWayUrl(id: string) {
	return `/api/external-accounts/${encodeURIComponent(id)}/two-way`;
}

/** `storedOnly` is the closed row's summary: answered from what is stored, never by asking the account's server. */
export async function fetchTwoWay(id: string, storedOnly = false): Promise<TwoWayView> {
	const response = await authFetch(storedOnly ? `${twoWayUrl(id)}?support=stored` : twoWayUrl(id), {
		cache: "no-store",
	});
	return (await readJson<{ twoWay: TwoWayView }>(response, "Could not load the two-way settings")).twoWay;
}

export async function saveTwoWay(id: string, settings: TwoWaySettings): Promise<TwoWayView> {
	const response = await authFetch(twoWayUrl(id), {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	return (await readJson<{ twoWay: TwoWayView }>(response, "Could not save the two-way settings")).twoWay;
}

/** Which moves this server can make: a move needs a way to move and the folder it goes to. */
export function offeredMoves(support: ProviderSupport | null) {
	const canMove = !!support?.moveMethod;
	return {
		trash: canMove && !!support?.trashFolder,
		archive: canMove && !!support?.archiveFolder,
		spam: canMove && !!support?.junkFolder,
	};
}

/** The line under the settings when something cannot be offered. */
export function supportNote(support: ProviderSupport | null): string | null {
	if (!support) return "Kite could not ask this server what it supports, so moves are not offered yet.";
	if (!support.moveMethod) return "This server cannot move a message safely, so Kite offers no moves.";
	const missing = [
		!support.trashFolder && "Trash",
		!support.archiveFolder && "Archive",
		!support.junkFolder && "Spam",
	].filter((name): name is string => !!name);
	return missing.length ? `This account has no ${missing.join(", ")} folder Kite can move mail to.` : null;
}

/** The settings in a few words, for the closed row. */
export function twoWaySummary(settings: TwoWaySettings): string {
	const toProvider =
		settings.kiteDelete === "trash" ||
		settings.kiteArchive === "archive" ||
		settings.kiteSpam === "spam" ||
		settings.kiteFlags;
	const toKite = settings.providerGone === "trash" || settings.providerFlags;
	if (toProvider && toKite) return "On in both directions.";
	if (toProvider) return "On from Kite to the provider.";
	if (toKite) return "On from the provider to Kite.";
	return "Off: nothing done in one place changes the other.";
}
