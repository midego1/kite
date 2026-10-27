import { and, asc, desc, eq } from "drizzle-orm";
import { streamText, stepCountIs, ToolChoiceViolationError } from "ai";
import { getDb, type AppDatabase } from "@/db";
import { agentChatMessages, agentConversations } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { getAgentModel } from "./model";
import { agentSystemPrompt } from "./system-prompt-utils";
import { agentProviderErrorMessage } from "./errors";
import { getAgentEnabled } from "./provider";
import { readMailboxAgentSettingsRow } from "./auto-read/mailbox-settings";
import { getAutoReadInstallSettings } from "./auto-read/install-settings";
import { chatSpendCapError, createChatSpend } from "./chat-spend";
import { CHAT_STEP_MAX_OUTPUT_TOKENS, stepPromptChars } from "./chat-spend-utils";
import { personalInstructionsFor } from "./user-ai-settings";
import { styleDescriptionFor } from "./writing-style";
import { attachHistoryRefs, buildChatTools, resolveToolResultRefs } from "./chat-tools";
import type { AgentToolContext } from "./types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { AGENT_STEP_LIMIT_FALLBACK, agentStepSettings, clampAgentMaxSteps } from "./step-limit-utils";
import { serializeAgentToolOutput } from "./tool-history-utils";
import { withCurrentEmailContext } from "./current-email-utils";
import { ownMessage } from "./tool-messages";

export async function getAgentConversation(context: AgentToolContext, conversationId: string) {
	const db = getDb(context.env);
	const [conversation] = await db
		.select()
		.from(agentConversations)
		.where(
			and(
				eq(agentConversations.id, conversationId),
				eq(agentConversations.userId, context.user.id),
				eq(agentConversations.mailboxId, context.mailboxId),
			),
		)
		.limit(1);
	return conversation ?? null;
}

export async function listAgentConversations(context: AgentToolContext) {
	const db = getDb(context.env);
	const access = await getMailboxAccessLevel(db, context.user, context.mailboxId);
	if (!access?.canRead) throw new Error("Mailbox not found");
	return db
		.select()
		.from(agentConversations)
		.where(and(eq(agentConversations.userId, context.user.id), eq(agentConversations.mailboxId, context.mailboxId)))
		.orderBy(desc(agentConversations.updatedAt))
		.limit(30);
}

export async function getAgentChatHistory(context: AgentToolContext, conversationId: string) {
	if (!(await getAgentConversation(context, conversationId))) throw new Error("Conversation not found");
	const rows = await getDb(context.env)
		.select()
		.from(agentChatMessages)
		.where(eq(agentChatMessages.conversationId, conversationId))
		.orderBy(asc(agentChatMessages.createdAt))
		.limit(200);
	return attachHistoryRefs(context, rows);
}

/** The open email, under the same rule as get_email: in this mailbox, and never another user's draft. */
async function resolveCurrentEmailId(context: AgentToolContext, messageId?: string) {
	if (!messageId) return null;
	return ownMessage(context, messageId).then(
		(row) => row.id,
		() => null,
	);
}

/** The assistant's text and reasoning of a turn, kept when the turn ends, also after an error. */
async function saveTurnText(db: AppDatabase, conversationId: string, response: string, reasoning: string) {
	if (reasoning.trim())
		await db.insert(agentChatMessages).values({
			id: newId("chat"),
			conversationId,
			role: "tool",
			toolName: "__reasoning__",
			content: reasoning.slice(0, 20_000),
		});
	if (response.trim())
		await db
			.insert(agentChatMessages)
			.values({ id: newId("chat"), conversationId, role: "assistant", content: response });
}

/** A failed tool call, stored in the conversation, as the event the panel shows. */
async function recordToolError(
	db: AppDatabase,
	conversationId: string,
	part: { toolCallId: string; toolName: string; error: unknown },
) {
	const message = agentProviderErrorMessage(part.error);
	await db
		.insert(agentChatMessages)
		.values({ id: newId("chat"), conversationId, role: "tool", toolName: part.toolName, content: message });
	return { type: "tool", id: part.toolCallId, name: part.toolName, state: "failed", result: message };
}

/** A spend cap explains itself; anything else is reported as the provider's error. */
function chatErrorMessage(error: unknown): string {
	return chatSpendCapError(error)?.message ?? agentProviderErrorMessage(error);
}

export async function createAgentChatStream(
	context: AgentToolContext,
	text: string,
	conversationId?: string,
	signal?: AbortSignal,
	timeZone?: string,
	currentMessageId?: string,
) {
	timeZone = normalizeTimeZone(timeZone ?? context.timeZone);
	context = { ...context, timeZone };
	const db = getDb(context.env);
	const access = await getMailboxAccessLevel(db, context.user, context.mailboxId);
	if (!access?.canRead) throw new Error("Mailbox not found");
	if (!(await getAgentEnabled(context.env))) throw new Error("Assistant is disabled");
	const settings = await readMailboxAgentSettingsRow(db, context.mailboxId);
	const selection = await getAgentModel(context.env, settings?.modelId);
	if (!selection) throw new Error("AI provider is not configured");
	const currentEmailId = await resolveCurrentEmailId(context, currentMessageId);
	let conversation = conversationId ? await getAgentConversation(context, conversationId) : null;
	if (conversationId && !conversation) throw new Error("Conversation not found");
	if (!conversation) {
		const id = newId("conv");
		await db
			.insert(agentConversations)
			.values({ id, userId: context.user.id, mailboxId: context.mailboxId, title: text.slice(0, 80) });
		conversation = await getAgentConversation(context, id);
	}
	if (!conversation) throw new Error("Cannot create conversation");
	const history = await db
		.select()
		.from(agentChatMessages)
		.where(eq(agentChatMessages.conversationId, conversation.id))
		.orderBy(desc(agentChatMessages.createdAt))
		.limit(30);
	await db
		.insert(agentChatMessages)
		.values({ id: newId("chat"), conversationId: conversation.id, role: "user", content: text });
	const prompt = history
		.reverse()
		.filter((row) => row.role === "user" || row.role === "assistant")
		.map((row) => ({ role: row.role as "user" | "assistant", content: row.content }));
	prompt.push({ role: "user", content: withCurrentEmailContext(text, currentEmailId) });
	const { tools, fragments } = await buildChatTools(context);
	const system = agentSystemPrompt(settings?.instructions ?? "", timeZone, fragments, {
		mailbox: { chat: settings?.chatInstructions ?? "", draft: settings?.draftInstructions ?? "" },
		personal: await personalInstructionsFor(db, context.user),
		writingStyle: await styleDescriptionFor(db, context.user.id, context.mailboxId),
	});
	const maxSteps = clampAgentMaxSteps(context.user.agentMaxSteps);
	const install = await getAutoReadInstallSettings(context.env);
	const spend = createChatSpend({
		env: context.env,
		details: selection,
		mailboxId: context.mailboxId,
		installCapMicros: install.dailySpendCapMicros,
		mailboxCapMicros: settings?.dailySpendCapMicros ?? null,
		tokenCap: install.chatTokenCap,
	});
	const result = streamText({
		model: selection.model,
		system,
		messages: prompt,
		tools,
		stopWhen: stepCountIs(maxSteps),
		// Every step reserves its estimate against the daily caps first; a refused step ends the turn.
		prepareStep: async ({ stepNumber, messages }) => {
			const step = agentStepSettings(stepNumber, maxSteps, system);
			await spend.beforeStep(stepPromptChars(step?.instructions ?? system, messages));
			return step;
		},
		maxOutputTokens: CHAT_STEP_MAX_OUTPUT_TOKENS,
		abortSignal: signal,
		onStepFinish: async ({ usage }) => {
			await spend.afterStep(usage);
		},
		// A step refused at the spend cap is an expected end of the turn, not an error worth a stack trace.
		onError: ({ error }) => {
			if (!chatSpendCapError(error)) console.error(error);
		},
	});
	const encoder = new TextEncoder();
	const id = conversation.id;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let response = "";
			let stepText = "";
			let reasoning = "";
			let lastFinishReason: string | null = null;
			let toolChoiceIgnored = false;
			let capReached = false;
			const emit = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			emit({ type: "conversation", conversationId: id });
			try {
				for await (const part of result.fullStream) {
					if (part.type === "text-delta") {
						response += part.text;
						stepText += part.text;
						emit({ type: "text", text: part.text });
					} else if (part.type === "reasoning-delta") {
						reasoning += part.text;
						emit({ type: "reasoning", text: part.text });
					} else if (part.type === "finish-step") {
						lastFinishReason = part.finishReason;
						if (part.finishReason === "tool-calls" && stepText) {
							response = response.slice(0, -stepText.length);
							reasoning += stepText;
							emit({ type: "reclassify", text: stepText });
						}
						stepText = "";
					} else if (part.type === "tool-call") {
						emit({ type: "tool", id: part.toolCallId, name: part.toolName, state: "running" });
					} else if (part.type === "tool-result") {
						const recordId = newId("chat");
						await db.insert(agentChatMessages).values({
							id: recordId,
							conversationId: id,
							role: "tool",
							toolName: part.toolName,
							content: serializeAgentToolOutput(part.output),
						});
						emit({
							type: "tool",
							id: part.toolCallId,
							name: part.toolName,
							state: "complete",
							result: await resolveToolResultRefs(context, part.output).catch(() => part.output),
							recordId,
						});
					} else if (part.type === "tool-error") {
						emit(await recordToolError(db, id, part));
					} else if (part.type === "error") {
						// The SDK reports a tool call on the toolChoice "none" final step as an error part.
						if (ToolChoiceViolationError.isInstance(part.error)) toolChoiceIgnored = true;
						else {
							capReached ||= !!chatSpendCapError(part.error);
							emit({ type: "error", message: chatErrorMessage(part.error) });
						}
					}
				}
				// A model that ignores toolChoice "none" can still end on a tool call; never leave the user without a reply.
				// A turn stopped at a spend cap already said why, so it does not get the step-limit text.
				if (!capReached && !response.trim() && (lastFinishReason === "tool-calls" || toolChoiceIgnored)) {
					response = AGENT_STEP_LIMIT_FALLBACK;
					emit({ type: "text", text: response });
				}
				await saveTurnText(db, id, response, reasoning);
				await db.update(agentConversations).set({ updatedAt: new Date() }).where(eq(agentConversations.id, id));
				emit({ type: "done" });
			} catch (error) {
				await saveTurnText(db, id, response, reasoning);
				emit({ type: "error", message: chatErrorMessage(error) });
			} finally {
				await spend.settle().catch(() => undefined);
				controller.close();
			}
		},
	});
	return { conversationId: id, stream };
}
