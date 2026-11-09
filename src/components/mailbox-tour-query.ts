import { authFetch } from "@/lib/auth/client";
import type { LayoutPreferencesResponse } from "@/lib/preferences/layout-types";

export const MAILBOX_TOUR_QUERY = ["mailbox-tour"] as const;

/** Fired to open the tour from outside the dialog, such as the account menu's replay action. */
export const MAILBOX_TOUR_REPLAY_EVENT = "kite:mailbox-tour-replay";

export function requestMailboxTourReplay(): void {
	window.dispatchEvent(new Event(MAILBOX_TOUR_REPLAY_EVENT));
}

/**
 * Whether the tour should stay closed: either this account already finished or skipped it, or the layout
 * cannot be stored yet (`ready` is false, before migration 0080), when showing it would be pointless because
 * nothing could remember the choice and it would just come back on the next page.
 */
export async function fetchMailboxTourDismissed(): Promise<boolean> {
	const response = await authFetch("/api/settings/layout", { cache: "no-store" });
	if (!response.ok) throw new Error(`Mailbox tour state request failed (${response.status})`);
	const data = (await response.json()) as LayoutPreferencesResponse;
	return !data.ready || data.layout?.mailboxTourDismissed === true;
}

export async function saveMailboxTourDismissed(dismissed: boolean): Promise<void> {
	const response = await authFetch("/api/settings/layout", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ layout: { mailboxTourDismissed: dismissed } }),
	});
	if (!response.ok) throw new Error(`Saving the mailbox tour state failed (${response.status})`);
}
