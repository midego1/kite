import {
	generateText,
	jsonSchema,
	NoObjectGeneratedError,
	Output,
	type LanguageModel,
	type LanguageModelUsage,
} from "ai";
import type { ModelCallOptions, ModelCallResult } from "./model-call-utils";
import type { TriagePrompt } from "./triage-types";

// Longer than any provider takes for a triage answer (and the fake model's 20 s `slow` reply), far
// shorter than the job's 10-minute lease.
const TRIAGE_CALL_TIMEOUT_MS = 60_000;

// A loose shape for providers that constrain decoding to a schema; parseTriageOutput stays the real check.
const TRIAGE_JSON_SCHEMA = jsonSchema({
	type: "object",
	properties: {
		category: {
			type: "string",
			enum: ["needs_reply", "fyi", "calendar", "receipt", "newsletter", "notification", "other"],
		},
		needsReply: { type: "boolean" },
		urgency: { type: "string", enum: ["none", "low", "high"] },
		summary: { type: "string" },
		tasks: {
			type: "array",
			items: {
				type: "object",
				properties: { title: { type: "string" }, dueAt: { type: "string" } },
				required: ["title"],
			},
		},
		suspicious: {
			type: "object",
			properties: { flagged: { type: "boolean" }, reasons: { type: "array", items: { type: "string" } } },
			required: ["flagged", "reasons"],
		},
	},
	required: ["category", "needsReply", "urgency", "summary", "tasks", "suspicious"],
});

export type TriageModelResult = ModelCallResult & { usage: LanguageModelUsage | undefined };

/**
 * workers-ai-provider ignores `response_format` in provider options; it only sends JSON mode for
 * the AI SDK's own structured output. Compatible providers get `json_object` from provider options.
 */
function structuredOutput(options: ModelCallOptions) {
	return options.provider === "cloudflare" && options.jsonMode
		? Output.object({ schema: TRIAGE_JSON_SCHEMA })
		: undefined;
}

/** One automatic triage request: no tools, no SDK retries (the job retries), provider-aware options. */
export async function generateTriageText(
	model: LanguageModel,
	prompt: TriagePrompt,
	options: ModelCallOptions,
): Promise<TriageModelResult> {
	try {
		const result = await generateText({
			model,
			system: prompt.system,
			messages: prompt.messages,
			maxOutputTokens: options.maxOutputTokens,
			providerOptions: options.providerOptions,
			output: structuredOutput(options),
			maxRetries: 0,
			abortSignal: AbortSignal.timeout(TRIAGE_CALL_TIMEOUT_MS),
		});
		return { text: result.text, finishReason: result.finishReason, usage: result.usage };
	} catch (error) {
		// The SDK's own JSON check rejects fenced or truncated replies; triage parsing decides instead.
		if (NoObjectGeneratedError.isInstance(error))
			return { text: error.text ?? "", finishReason: error.finishReason ?? "other", usage: error.usage };
		throw error;
	}
}
