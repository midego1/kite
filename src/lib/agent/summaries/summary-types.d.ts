import type { PersonalInstructions } from "../instruction-types";

/** What the Summarize button summarises: the conversation, or one message of it. */
export type SummaryScope = "thread" | "message";

export type SummaryLabel = "Asks" | "Decisions" | "Dates" | "Next steps";

export type SummaryPoint = { label: SummaryLabel; text: string };

/** A checked summary: plain text, its language as an ISO 639-1 code (or `und`). */
export type SummaryContent = { language: string; overview: string; points: SummaryPoint[] };

/** One eligible message as the prompt sees it; `text` is the readable body without quoted replies. */
export type SummaryMessage = {
	id: string;
	from: string;
	subject: string;
	date: Date;
	direction: "inbound" | "outbound";
	text: string;
};

export type SummaryPromptInput = {
	/** Every eligible message of the conversation (or the one message), oldest first. */
	messages: SummaryMessage[];
	instructions: { general: string; summary: string };
	personal: PersonalInstructions | null;
	nonce?: string;
};

export type TranslationPromptInput = {
	summary: Pick<SummaryContent, "overview" | "points">;
	/** ISO 639-1 code of the target language. */
	target: string;
	nonce?: string;
};

export type SummaryPrompt = { system: string; messages: { role: "user" | "assistant"; content: string }[] };

export type SummaryOutcome = { ok: true; summary: SummaryContent } | { ok: false; error: string };

/** What the reader gets for one message and scope; `null` summary when none is cached for this user. */
export type SummaryState = {
	summary: {
		scope: SummaryScope;
		language: string;
		overview: string;
		points: SummaryPoint[];
		stale: boolean;
		createdAt: string;
		model: string | null;
	} | null;
	translation: { language: string; overview: string; points: SummaryPoint[] } | null;
	translatable: boolean;
	eligible: boolean;
	reason?: "not_eligible" | "assistant_off" | "no_provider" | "external_provider_not_allowed";
	migrationPending?: boolean;
};
