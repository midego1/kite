import type { MessageFacts } from "./facts-types";

export type TriageCategory = "needs_reply" | "fyi" | "calendar" | "receipt" | "newsletter" | "notification" | "other";
export type TriageUrgency = "none" | "low" | "high";
export type TriageSuspiciousReason =
	"credential_request" | "payment_change" | "urgency_pressure" | "spoofed_identity" | "unexpected_attachment";

export type TriageTask = { title: string; dueAt?: string };

/** The closed triage schema: no address, URL or instruction fields exist for a model to fill. */
export type TriageResult = {
	category: TriageCategory;
	needsReply: boolean;
	urgency: TriageUrgency;
	summary: string;
	tasks: TriageTask[];
	suspicious: { flagged: boolean; reasons: TriageSuspiciousReason[] };
};

export type TriageParseOutcome = { ok: true; result: TriageResult } | { ok: false; error: string };

export type TriageChatMessage = { role: "user" | "assistant"; content: string };

/** A model request without tools: the automatic path never offers any. */
export type TriagePrompt = { system: string; messages: TriageChatMessage[] };

export type TriagePromptInput = {
	messageId: string;
	from: string;
	subject: string | null;
	/** The latest message as readable text; cut to 8,000 characters. */
	body: string;
	threadSubjects?: string[];
	/** Deterministic facts, summarised by code outside the email block. */
	facts?: MessageFacts;
	/** Mailbox preferences; at most 4,000 characters, and they cannot override the rules. */
	instructions?: string;
	nonce?: string;
	/** Lets the model resolve relative due dates; defaults to the current time. */
	now?: Date;
};
