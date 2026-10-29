import { and, desc, eq } from "drizzle-orm";
import { generateText, type JSONValue, type LanguageModel, type LanguageModelUsage } from "ai";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { loadMessageBodies } from "@/lib/email/bodies";
import type { DraftPreferences } from "../instruction-types";
import { buildReplyDraftPrompt } from "./draft-prompt-utils";

const DRAFT_THREAD_WINDOW = 20;
const DEFAULT_MAX_OUTPUT_TOKENS = 900;

type ThreadMessage = typeof messages.$inferSelect;

/** The last twenty messages of the source's thread, oldest first (just the source when it has no thread). */
export async function loadDraftThread(
	env: CloudflareEnv,
	mailboxId: string,
	source: ThreadMessage,
): Promise<ThreadMessage[]> {
	if (!source.threadId) return loadMessageBodies(env, [source]);
	const rows = await getDb(env)
		.select()
		.from(messages)
		.where(and(eq(messages.mailboxId, mailboxId), eq(messages.threadId, source.threadId)))
		.orderBy(desc(messages.createdAt))
		.limit(DRAFT_THREAD_WINDOW);
	// The guard checks the draft against links and facts in the HTML too, so the bodies are read whole.
	return loadMessageBodies(env, rows.reverse());
}

type GenerateReplyDraftInput = {
	model: LanguageModel;
	instructions: string;
	/** The mailbox's drafting field and the reviewer's own instructions. */
	preferences?: DraftPreferences;
	thread: ThreadMessage[];
	maxOutputTokens?: number;
	providerOptions?: Record<string, Record<string, JSONValue>>;
	maxRetries?: number;
	abortSignal?: AbortSignal;
	onUsage?: (usage: LanguageModelUsage, finishReason: string) => Promise<void>;
};

export type GeneratedReplyDraft = { text: string; finishReason: string; usage: LanguageModelUsage | undefined };

/**
 * Writes a plain-text reply to the latest inbound message of the thread. Shared by the legacy
 * auto-draft job and triage reply suggestions; it calls the model without tools.
 */
export async function generateReplyDraft(input: GenerateReplyDraftInput): Promise<GeneratedReplyDraft> {
	const { system, prompt } = buildReplyDraftPrompt(input.instructions, input.thread, input.preferences);
	const onUsage = input.onUsage;
	const generated = await generateText({
		model: input.model,
		system,
		prompt,
		maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
		...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
		...(input.maxRetries === undefined ? {} : { maxRetries: input.maxRetries }),
		...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
		...(onUsage
			? {
					onStepFinish: async ({ usage, finishReason }: { usage: LanguageModelUsage; finishReason: string }) =>
						onUsage(usage, finishReason),
				}
			: {}),
	});
	return { text: generated.text.trim(), finishReason: generated.finishReason, usage: generated.usage };
}

export function draftPromptChars(input: {
	instructions: string;
	preferences?: DraftPreferences;
	thread: ThreadMessage[];
}): number {
	const { system, prompt } = buildReplyDraftPrompt(input.instructions, input.thread, input.preferences);
	return system.length + prompt.length;
}
