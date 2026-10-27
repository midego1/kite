import type { AgentProviderConfig } from "../provider-types";
import { selectAutoReadModel } from "./auto-read-model";
import { buildModelCallOptions, chooseTriageModelId, runTriageAttempt } from "./model-call-utils";
import { extensionOutputTokens, type ActiveModelExtension } from "./model-extension-utils";
import type { MailboxAgentSettingsState } from "./settings-types";
import { withReservedSpend } from "./spend";
import type { TriageContext } from "./triage-context";
import { generateTriageText } from "./triage-model";
import type { TriagePrompt, TriageResult } from "./triage-types";
import { buildTriageJsonSchema, buildTriagePrompt } from "./triage-utils";

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
	/** Automatic reading's daily input-token allowance, used without model rates. */
	tokenCap: number;
	/** The module extensions active for this mailbox and reviewer; empty keeps the request exactly as before. */
	extensions?: readonly ActiveModelExtension[];
};

function callExtension(extensions: readonly ActiveModelExtension[]) {
	if (extensions.length === 0) return undefined;
	return { outputTokens: extensionOutputTokens(extensions), schema: buildTriageJsonSchema(extensions) };
}

function promptChars(prompt: TriagePrompt): number {
	return prompt.system.length + prompt.messages.reduce((sum, message) => sum + message.content.length, 0);
}

/**
 * Runs one triage attempt against the mailbox's triage model. Every model request (including the
 * repair and a parameter fallback) reserves its estimated cost first and is reconciled afterwards.
 */
export async function runTriageModel(input: TriageRunInput): Promise<{ result: TriageResult; modelId: string }> {
	const { env, job, settings, context, config } = input;
	const extensions = input.extensions ?? [];
	const requested = chooseTriageModelId({
		triageModelId: settings.triageModelId,
		mailboxModelId: settings.modelId,
		models: config.models,
		rates: config.rates,
	});
	const selection = await selectAutoReadModel(env, requested);
	const prompt = buildTriagePrompt({
		messageId: context.source.id,
		from: context.source.fromAddr,
		subject: context.source.subject,
		body: context.bodyText,
		threadSubjects: context.threadSubjects,
		facts: context.facts,
		instructions: settings.instructions,
		extensionInstructions: extensions.map((extension) => extension.instructions),
	});
	const { result } = await runTriageAttempt({
		prompt,
		options: buildModelCallOptions({
			provider: selection.providerKind,
			preset: selection.preset,
			kind: "triage",
			reasoningEffort: selection.reasoningEffort,
			extension: callExtension(extensions),
		}),
		activeModuleIds: extensions.map((extension) => extension.moduleId),
		generate: async (request, options) => {
			// The repair and a parameter fallback are new requests, so the opt-in is checked again.
			const current = await selectAutoReadModel(env, requested);
			const reply = await withReservedSpend(
				{
					env,
					details: current,
					source: "auto_triage",
					mailboxId: job.mailboxId,
					jobId: job.id,
					promptChars: promptChars(request),
					maxOutputTokens: options.maxOutputTokens,
					installCapMicros: input.installCapMicros,
					tokenCap: input.tokenCap,
					mailboxCapMicros: settings.dailySpendCapMicros,
				},
				() => generateTriageText(current.model, request, options),
			);
			if (!reply) throw new SpendCapReachedError();
			return reply;
		},
	});
	return { result, modelId: selection.modelId };
}
