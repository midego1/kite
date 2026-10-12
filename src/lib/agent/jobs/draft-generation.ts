import { and, desc, eq } from "drizzle-orm";
import { generateText, type JSONValue, type LanguageModel, type LanguageModelUsage } from "ai";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { buildReplyDraftPrompt } from "./draft-prompt-utils";

const DRAFT_THREAD_WINDOW = 20;
const DEFAULT_MAX_OUTPUT_TOKENS = 900;

type ThreadMessage = typeof messages.$inferSelect;

/** The last twenty messages of the source's thread, oldest first (just the source when it has no thread). */
export async function loadDraftThread(
	db: AppDatabase,
	mailboxId: string,
	source: ThreadMessage,
): Promise<ThreadMessage[]> {
	if (!source.threadId) return [source];
	const rows = await db
		.select()
		.from(messages)
		.where(and(eq(messages.mailboxId, mailboxId), eq(messages.threadId, source.threadId)))
		.orderBy(desc(messages.createdAt))
		.limit(DRAFT_THREAD_WINDOW);
	return rows.reverse();
}

type GenerateReplyDraftInput = {
	model: LanguageModel;
	instructions: string;
	thread: ThreadMessage[];
	maxOutputTokens?: number;
	providerOptions?: Record<string, Record<string, JSONValue>>;
	maxRetries?: number;
	abortSignal?: AbortSignal;
	onUsage?: (usage: LanguageModelUsage) => Promise<void>;
};

export type GeneratedReplyDraft = { text: string; finishReason: string; usage: LanguageModelUsage | undefined };

/**
 * Writes a plain-text reply to the latest inbound message of the thread. Shared by the legacy
 * auto-draft job and triage reply suggestions; it calls the model without tools.
 */
export async function generateReplyDraft(input: GenerateReplyDraftInput): Promise<GeneratedReplyDraft> {
	const { system, prompt } = buildReplyDraftPrompt(input.instructions, input.thread);
	const onUsage = input.onUsage;
	const generated = await generateText({
		model: input.model,
		system,
		prompt,
		maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
		...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
		...(input.maxRetries === undefined ? {} : { maxRetries: input.maxRetries }),
		...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
		...(onUsage ? { onStepFinish: async ({ usage }: { usage: LanguageModelUsage }) => onUsage(usage) } : {}),
	});
	return { text: generated.text.trim(), finishReason: generated.finishReason, usage: generated.usage };
}

export function draftPromptChars(input: { instructions: string; thread: ThreadMessage[] }): number {
	const { system, prompt } = buildReplyDraftPrompt(input.instructions, input.thread);
	return system.length + prompt.length;
}
