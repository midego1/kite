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
