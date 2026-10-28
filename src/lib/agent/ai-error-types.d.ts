import type { AiErrorCode, AiFeature } from "./ai-error-utils";

/** What one failed AI request leaves in the `ai.error` audit row: codes and numbers, never content. */
export type AiErrorRecord = {
	code: AiErrorCode;
	feature: AiFeature;
	model: string | null;
	provider: string | null;
	status: number | null;
	durationMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	finishReason: string | null;
};

/** One row of Admin → Agent's Recent AI errors. */
export type RecentAiError = AiErrorRecord & {
	id: string;
	at: string;
	featureLabel: string;
	/** The email of the person whose request failed, or null for background work without one. */
	user: string | null;
	mailbox: string | null;
};
