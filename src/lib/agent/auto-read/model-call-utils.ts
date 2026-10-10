import type { JSONValue } from "ai";
import type { AgentProviderKind, AgentReasoningEffort } from "../provider-types";
import { parseAgentReasoningEffort } from "../reasoning-effort-utils";
import type { TriagePrompt, TriageResult } from "./triage-types";
import { buildTriageRepairPrompt, parseTriageOutput } from "./triage-utils";

/** The `name` given to `createOpenAICompatible`; its provider options are read from this key. */
export const COMPATIBLE_PROVIDER_NAME = "kite";
const TRIAGE_MAX_OUTPUT_TOKENS = 400;
const DRAFT_MAX_OUTPUT_TOKENS = 900;
// A reasoning model spends part of the budget thinking; 1500 fits a triage answer at minimal effort.
const REASONING_HEADROOM_TOKENS = 1_100;

type ModelCallKind = "triage" | "draft";

export type ModelCallOptions = {
	provider: AgentProviderKind;
	kind: ModelCallKind;
	maxOutputTokens: number;
	providerOptions: Record<string, Record<string, JSONValue>>;
	/** The reasoning effort actually sent, if any. */
	reasoningEffort: AgentReasoningEffort | null;
	jsonMode: boolean;
};

type ModelCallInput = {
	provider: AgentProviderKind;
	kind: ModelCallKind;
	/** The per-model hint saved with the provider settings (`rates[modelId].reasoningEffort`). */
	reasoningEffort?: unknown;
};

type ModelCallSettings = Pick<ModelCallOptions, "provider" | "kind" | "reasoningEffort">;

export type ModelCallResult = { text: string; finishReason: string };

export class ModelOutputTruncatedError extends Error {
	constructor() {
		super("The model ran out of output tokens before finishing");
		this.name = "ModelOutputTruncatedError";
	}
}

export class TriageOutputError extends Error {
	constructor(reason: string) {
		super(`The model did not return a valid triage object: ${reason}`);
		this.name = "TriageOutputError";
	}
}

function buildOptions(settings: ModelCallSettings, jsonMode: boolean): ModelCallOptions {
	const base = settings.kind === "triage" ? TRIAGE_MAX_OUTPUT_TOKENS : DRAFT_MAX_OUTPUT_TOKENS;
	const json: Record<string, JSONValue> = jsonMode ? { response_format: { type: "json_object" } } : {};
	if (settings.provider === "cloudflare") {
		// Kimi K2.5 ignores reasoning_effort; only switching thinking off keeps it fast and inside the budget.
		const options = { chat_template_kwargs: { thinking: false }, ...json };
		// workers-ai-provider 4 reads "workers-ai"; "workersAi" is the camel-cased key newer versions read.
		return {
			provider: "cloudflare",
			kind: settings.kind,
			maxOutputTokens: base,
			providerOptions: { workersAi: options, "workers-ai": options },
			reasoningEffort: null,
			jsonMode,
		};
	}
	const effort = settings.reasoningEffort;
	return {
		provider: settings.provider,
		kind: settings.kind,
		maxOutputTokens: effort ? base + REASONING_HEADROOM_TOKENS : base,
		providerOptions: { [COMPATIBLE_PROVIDER_NAME]: { ...json, ...(effort ? { reasoningEffort: effort } : {}) } },
		reasoningEffort: effort,
		jsonMode,
	};
}

/** Provider-aware options and output budget for one automatic model call (never any tools). */
export function buildModelCallOptions(input: ModelCallInput): ModelCallOptions {
	const reasoningEffort = parseAgentReasoningEffort(input.reasoningEffort) ?? null;
	return buildOptions({ provider: input.provider, kind: input.kind, reasoningEffort }, input.kind === "triage");
}

function errorStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const { statusCode, status } = error as { statusCode?: unknown; status?: unknown };
	if (typeof statusCode === "number") return statusCode;
	return typeof status === "number" ? status : undefined;
}

function errorText(error: unknown): string {
	if (!error || typeof error !== "object") return String(error ?? "");
	const { message, responseBody } = error as { message?: unknown; responseBody?: unknown };
	return `${typeof message === "string" ? message : ""} ${typeof responseBody === "string" ? responseBody : ""}`;
}

/**
 * The options to retry with after a 400 that rejects one of the optional parameters, or null when
 * the error is not such a rejection. Each parameter is dropped at most once.
 */
export function fallbackOptionsAfterError(options: ModelCallOptions, error: unknown): ModelCallOptions | null {
	if (errorStatus(error) !== 400) return null;
	const text = errorText(error);
	if (options.reasoningEffort && /reasoning/i.test(text))
		return buildOptions({ ...options, reasoningEffort: null }, options.jsonMode);
	if (options.jsonMode && /response_format|json_object|json mode/i.test(text)) return buildOptions(options, false);
	return null;
}

/** Runs `call`, retrying without a parameter the provider rejected with a 400. */
export async function callWithFallback<T>(
	options: ModelCallOptions,
	call: (options: ModelCallOptions) => Promise<T>,
): Promise<T> {
	let current = options;
	for (;;) {
		try {
			return await call(current);
		} catch (error) {
			const next = fallbackOptionsAfterError(current, error);
			if (!next) throw error;
			current = next;
		}
	}
}

/** A `length` finish is a failed attempt: partial JSON is never parsed or repaired. */
export function completedText(result: ModelCallResult): string {
	if (result.finishReason === "length") throw new ModelOutputTruncatedError();
	return result.text;
}

type TriageAttemptInput = {
	prompt: TriagePrompt;
	options: ModelCallOptions;
	generate: (prompt: TriagePrompt, options: ModelCallOptions) => Promise<ModelCallResult>;
	now?: Date;
};

/** One triage attempt: the model call, strict parsing and at most one repair call. */
export async function runTriageAttempt(input: TriageAttemptInput): Promise<{ result: TriageResult; calls: number }> {
	const run = (prompt: TriagePrompt) =>
		callWithFallback(input.options, (options) => input.generate(prompt, options)).then(completedText);
	const first = await run(input.prompt);
	const parsed = parseTriageOutput(first, input.now);
	if (parsed.ok) return { result: parsed.result, calls: 1 };
	const repaired = parseTriageOutput(await run(buildTriageRepairPrompt(input.prompt, first, parsed.error)), input.now);
	if (repaired.ok) return { result: repaired.result, calls: 2 };
	throw new TriageOutputError(repaired.error);
}
