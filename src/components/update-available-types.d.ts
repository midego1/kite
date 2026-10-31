import type { ChangelogRelease } from "@/lib/changelog/types";

export interface UpdateCheckState {
	now: number;
	/** When the previous request started, or null before the first one. */
	lastCheckAt: number | null;
	visible: boolean;
	inFlight: boolean;
}

export interface UpdateDecision {
	/** The version this tab loaded with; empty until the first answer that names one. */
	known: string;
	changed: boolean;
}

export interface UpdateNoticeState {
	/** A newer deployment is live. */
	available: boolean;
	/** The user closed the notice; it stays closed for the life of the tab. */
	dismissed: boolean;
	/** How many message lists are on screen to carry the pinned row. */
	lists: number;
	/** Reload was chosen: the host plays the flight and reloads, and the notice steps aside. */
	reloading: boolean;
	/** When this tab noticed the new deployment (ms), shown as the row's time. */
	detectedAt: number | null;
	/** The new deployment's release and notes, when its server named them. */
	details: UpdateDetails;
	/** "What's new" is open in the reader, as an opened message would be. */
	open: boolean;
	/** The reader was opened once, so the row no longer shows as unread. */
	read: boolean;
}

export interface UpdateDetails {
	/** The new release's calendar version, only when it differs from the one this tab runs. */
	release: string | null;
	/** Release notes this tab has not had yet, newest first; empty when unknown. */
	notes: ChangelogRelease[];
}

export type UpdateSurface = "none" | "row" | "toast";
