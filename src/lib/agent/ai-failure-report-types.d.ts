import type { AiErrorCode, AiFeature } from "./ai-error-utils";
import type { AiFailureFact } from "./cut-off-utils";

/** A settings page that can fix a group of failures. */
export type AiFailureLink = { href: string; label: string };

/** Failures of one code in the window: what failed, where, how often and what to do about it. No content. */
export type AiFailureGroup = {
	code: AiErrorCode;
	count: number;
	/** ISO times of the oldest and newest failure of the group. */
	firstAt: string;
	lastAt: string;
	features: { feature: AiFeature; label: string; count: number }[];
	/** Provider and model pairs, most failures first; a null model is a request that failed before choosing one. */
	models: { provider: string | null; providerLabel: string | null; model: string | null; count: number }[];
	/** The HTTP statuses the provider answered with, lowest first. */
	statuses: number[];
	/** Kite's own sentence for the newest failure; the provider's error text is never stored. */
	latestMessage: string;
	/** The likely cause and the fix, in plain words. */
	cause: string;
	fix: string;
	link: AiFailureLink | null;
	/** What Kite knows beyond the code, such as a cut-off answer's cap and thinking setting. */
	facts: AiFailureFact[];
};

/** Whether Ask AI can run, and why not when it cannot. */
export type AskAiState = { available: true } | { available: false; reason: string; link: AiFailureLink | null };

/** `GET /api/admin/agent/errors/report`: the last day's failed AI requests explained without a model call. */
export type AiFailureReport = {
	/** ISO start of the window. */
	since: string;
	total: number;
	/** More failures may have happened than the kept rows show. */
	capped: boolean;
	groups: AiFailureGroup[];
	/** The text Ask AI puts in the assistant: the groups in words, never a person, a mailbox or mail. */
	prompt: string;
	assistant: AskAiState;
};
