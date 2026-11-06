import { readAiErrorBody, type AiErrorBody } from "@/lib/agent/ai-error-utils";
import type { SummaryScope, SummaryState } from "@/lib/agent/summaries/summary-types";
import { languageName } from "@/lib/agent/summaries/summary-utils";

/** The summary route of a message, with the scope and the reader's language. */
export function summaryUrl(messageId: string, scope: SummaryScope, language: string | null): string {
	const params = new URLSearchParams({ scope });
	if (language) params.set("language", language);
	return `/api/messages/${encodeURIComponent(messageId)}/summary?${params}`;
}

/** Whether the Summarize button is shown: the message can be summarised here and the table exists. */
export function canSummarize(state: SummaryState | null): boolean {
	return !!state?.eligible && !state.migrationPending;
}

/** Whether a current summary is on screen, which hides the automatic-reading summary line next to it. */
export function showsCurrentSummary(state: SummaryState | null, hidden: boolean): boolean {
	return !hidden && !!state?.summary && !state.summary.stale;
}

/** "Translate to Dutch": the interface is English, so the language is named in English. */
export function translateLabel(language: string): string {
	return `Translate to ${languageName(language)}`;
}

/** The summary as plain text for Copy: the overview, then one line per point. */
export function summaryCopyText(summary: Pick<NonNullable<SummaryState["summary"]>, "overview" | "points">): string {
	return [summary.overview, ...summary.points.map((point) => `${point.label}: ${point.text}`)].join("\n");
}

/** The error text of a failed summary request, from the route's `{ error }` body, with an AI failure's details. */
export async function summaryError(response: Response): Promise<{ message: string; failure: AiErrorBody | null }> {
	const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
	return {
		message: typeof body?.error === "string" ? body.error : "Kite could not summarize this. Try again.",
		failure: readAiErrorBody(body),
	};
}

/** The per-minute AI request limit's window: a refusal for it lifts after this long (a spend cap lifts at 00:00 UTC). */
const RATE_LIMIT_RESET_MS = 60_000;

/** How long the Summarize button stays off after a 429 with this error code, or null when it stays off for the page. */
export function blockedResetMs(code: string | null | undefined): number | null {
	return code === "rate_limited" ? RATE_LIMIT_RESET_MS : null;
}

/** What a screen reader hears when a request starts or ends (the card's content swap alone is silent). */
export function summaryAnnouncement(kind: "summarize" | "translate", phase: "started" | "done"): string {
	if (kind === "translate") return phase === "started" ? "Translating the summary" : "Translation ready";
	return phase === "started" ? "Summarizing" : "Summary ready";
}
