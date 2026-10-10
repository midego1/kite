import type { LanguageModelUsage } from "ai";
import { getAgentModel } from "../model";
import type { AgentProviderConfig } from "../provider-types";
import { buildModelCallOptions, chooseTriageModelId, runTriageAttempt } from "./model-call-utils";
import type { MailboxAgentSettingsState } from "./settings-types";
import { reconcileAiSpend, reserveAiSpend } from "./spend";
import type { TriageContext } from "./triage-context";
import { generateTriageText } from "./triage-model";
import type { TriagePrompt, TriageResult } from "./triage-types";
import { buildTriagePrompt } from "./triage-utils";

export class SpendCapReachedError extends Error {
	constructor() {
		super("The daily automatic reading spend cap is reached");
		this.name = "SpendCapReachedError";
	}
}

type TriageRunInput = {
	env: CloudflareEnv;
	job: { id: string; mailboxId: string };
	settings: MailboxAgentSettingsState;
	context: TriageContext;
	config: AgentProviderConfig;
	installCapMicros: number;
};

function promptChars(prompt: TriagePrompt): number {
	return prompt.system.length + prompt.messages.reduce((sum, message) => sum + message.content.length, 0);
}

/**
 * Runs one triage attempt against the mailbox's triage model. Every model request (including the
 * repair and a parameter fallback) reserves its estimated cost first and is reconciled afterwards.
 */
export async function runTriageModel(input: TriageRunInput): Promise<{ result: TriageResult; modelId: string }> {
	const { env, job, settings, context, config } = input;
	const requested = chooseTriageModelId({
		triageModelId: settings.triageModelId,
		mailboxModelId: settings.modelId,
		models: config.models,
		rates: config.rates,
	});
	const selection = await getAgentModel(env, requested);
	if (!selection) throw new Error("AI provider is not configured");
	const prompt = buildTriagePrompt({
		messageId: context.source.id,
		from: context.source.fromAddr,
		subject: context.source.subject,
		body: context.bodyText,
		threadSubjects: context.threadSubjects,
		facts: context.facts,
		instructions: settings.instructions,
	});
	const { result } = await runTriageAttempt({
		prompt,
		options: buildModelCallOptions({
			provider: selection.providerKind,
			kind: "triage",
			reasoningEffort: selection.reasoningEffort,
		}),
		generate: async (request, options) => {
			const reservation = await reserveAiSpend({
				env,
				details: selection,
				source: "auto_triage",
				mailboxId: job.mailboxId,
				jobId: job.id,
				promptChars: promptChars(request),
				maxOutputTokens: options.maxOutputTokens,
				installCapMicros: input.installCapMicros,
				mailboxCapMicros: settings.dailySpendCapMicros,
			});
			if (!reservation) throw new SpendCapReachedError();
			let usage: LanguageModelUsage | undefined;
			try {
				const reply = await generateTriageText(selection.model, request, options);
				usage = reply.usage;
				return reply;
			} finally {
				await reconcileAiSpend({ env, reservation, rates: selection.rates, usage });
			}
		},
	});
	return { result, modelId: selection.modelId };
}
