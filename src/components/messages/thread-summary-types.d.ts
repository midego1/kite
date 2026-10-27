import type { SummaryScope, SummaryState } from "@/lib/agent/summaries/summary-types";

export type ThreadSummaryBusy = "summarize" | "translate" | null;

/** Everything the reader's Summarize button and card share for the open message. */
export type ThreadSummaryController = {
	scope: SummaryScope;
	state: SummaryState | null;
	busy: ThreadSummaryBusy;
	error: string | null;
	/** Why the button is disabled after a cap or the rate limit refused it. */
	blocked: string | null;
	hidden: boolean;
	/** The reader's language, the primary subtag of the browser's. */
	language: string | null;
	summarize: (scope?: SummaryScope) => void;
	/** Summarizes the open message alone; undefined where it cannot be summarised. */
	summarizeMessage: (() => void) | undefined;
	translate: () => void;
	hide: () => void;
};
