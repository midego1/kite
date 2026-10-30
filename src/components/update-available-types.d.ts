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
}

export type UpdateSurface = "none" | "row" | "toast";
