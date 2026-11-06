import type { AiErrorBody } from "@/lib/agent/ai-error-utils";
import type { SummaryScope, SummaryState } from "@/lib/agent/summaries/summary-types";

export type ThreadSummaryBusy = "summarize" | "translate" | null;

/** Everything the reader's Summarize button and card share for the open message. */
export type ThreadSummaryController = {
	scope: SummaryScope;
	state: SummaryState | null;
	busy: ThreadSummaryBusy;
	error: string | null;
	/** The code and details of a failed AI request, for the card's Details. */
	failure: AiErrorBody | null;
	/** Why the button is off after a cap or the rate limit refused it; the rate limit's lifts by itself. */
	blocked: string | null;
	/** A polite announcement for screen readers: a request started or finished. */
	announcement: string;
	hidden: boolean;
	/** The reader's language, the primary subtag of the browser's. */
	language: string | null;
	summarize: (scope?: SummaryScope) => void;
	/** Summarizes the open message alone; undefined where it cannot be summarised. */
	summarizeMessage: (() => void) | undefined;
	translate: () => void;
	/** Repeats the request that failed; undefined while a request runs or a cap blocks the button. */
	retry: (() => void) | undefined;
	hide: () => void;
};
