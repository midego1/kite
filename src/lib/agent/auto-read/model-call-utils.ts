import type { JSONValue } from "ai";
import type { JsonSchemaObject } from "@/lib/modules/module-types";
import type { AgentModelRates, AgentProviderKind, AgentProviderPreset, AgentReasoningEffort } from "../provider-types";
import {
	claudeThinkingDefault,
	CUT_OFF_RETRY_FACTOR,
	DRAFT_ANSWER_TOKENS,
	THINKING_ROOM_TOKENS,
	TRIAGE_ANSWER_TOKENS,
	type AiOutputBudget,
	type AiThinkingSetting,
} from "../output-budget-utils";
import { parseAgentReasoningEffort } from "../reasoning-effort-utils";
import type { TriagePrompt, TriageResult } from "./triage-types";
import { buildTriageRepairPrompt, parseTriageOutput } from "./triage-utils";

/** The `name` given to `createOpenAICompatible`; its provider options are read from this key. */
export const COMPATIBLE_PROVIDER_NAME = "kite";

type ModelCallKind = "triage" | "draft";

/** What active module extensions add to a triage request: extra output tokens and the merged provider schema. */
export type ModelCallExtension = {
	outputTokens: number;
	/** The provider schema with the `modules` fragments; null once a provider rejected `json_schema`. */
	schema: JsonSchemaObject | null;
};

export type ModelCallOptions = {
	provider: AgentProviderKind;
	preset: AgentProviderPreset;
	kind: ModelCallKind;
	/** The model the request goes to, which decides how a Claude model's thinking is set. */
	modelId: string | null;
	maxOutputTokens: number;
	providerOptions: Record<string, Record<string, JSONValue>>;
	/** The per-model reasoning effort hint the options were built from, if any. */
	reasoningEffort: AgentReasoningEffort | null;
	/** The effort actually sent, if any (Anthropic has no `minimal`; a model that always thinks gets `low`). */
	effort: string | null;
	/** How thinking is set: off, asked for with an effort, or left to the provider's default. */
	thinking: AiThinkingSetting;
	/** The part of `maxOutputTokens` added for thinking. */
	thinkingRoom: number;
	jsonMode: boolean;
	/** Only present for a triage request with active module extensions. */
	extension?: ModelCallExtension;
	/** The second try after a cut-off answer, with `CUT_OFF_RETRY_FACTOR` times the budget. */
	retried?: boolean;
	/** Anthropic refused the thinking or effort parameter once, so neither is sent again. */
	plainThinking?: boolean;
};

type ModelCallInput = {
	provider: AgentProviderKind;
	preset?: AgentProviderPreset;
	kind: ModelCallKind;
	modelId?: string | null;
	/** The per-model hint saved with the provider settings (`rates[modelId].reasoningEffort`). */
	reasoningEffort?: unknown;
	extension?: ModelCallExtension;
};

type ModelCallSettings = Pick<
	ModelCallOptions,
	"provider" | "preset" | "kind" | "modelId" | "reasoningEffort" | "extension" | "retried" | "plainThinking"
>;

export type ModelCallResult = {
	text: string;
	finishReason: string;
	usage?: { outputTokens?: number; outputTokenDetails?: { reasoningTokens?: number } } | undefined;
};

export class ModelOutputTruncatedError extends Error {
	/** The cap, thinking setting and usage of the cut-off attempt, for Why? and Ask AI. */
	readonly budget: AiOutputBudget | null;
	constructor(budget: AiOutputBudget | null = null) {
		super("The model ran out of output tokens before finishing");
		this.name = "ModelOutputTruncatedError";
		this.budget = budget;
	}
}

export class TriageOutputError extends Error {
	constructor(reason: string) {
		super(`The model did not return a valid triage object: ${reason}`);
		this.name = "TriageOutputError";
	}
}

/** A compatible provider gets the merged schema as `json_schema` while extensions are active, else `json_object`. */
function responseFormat(jsonMode: boolean, extension: ModelCallExtension | undefined): Record<string, JSONValue> {
	if (!jsonMode) return {};
	if (!extension?.schema) return { response_format: { type: "json_object" } };
	return { response_format: { type: "json_schema", json_schema: { name: "triage", schema: extension.schema } } };
}

type ThinkingChoice = {
	options: Record<string, JSONValue>;
	thinking: AiThinkingSetting;
	effort: string | null;
	room: number;
};

/**
 * Anthropic's thinking for one automatic request. Claude 5 models think by default when `thinking` is left out
 * (Haiku 5.5 at effort high), and thinking counts against `max_tokens`, so a 400-token triage answer was spent
 * thinking and cut off. Without a hint, thinking is switched off where the model allows it; a model that always
 * thinks gets effort low and the thinking room. `minimal` has no Anthropic effort and means as little as allowed.
 */
function anthropicThinking(settings: ModelCallSettings): ThinkingChoice {
	const hint = settings.reasoningEffort;
	if (settings.plainThinking) return { options: {}, thinking: "default", effort: null, room: THINKING_ROOM_TOKENS };
	if (hint && hint !== "minimal")
		return { options: { effort: hint }, thinking: "on", effort: hint, room: THINKING_ROOM_TOKENS };
	if (claudeThinkingDefault(settings.modelId) === "always")
		return { options: { effort: "low" }, thinking: "on", effort: "low", room: THINKING_ROOM_TOKENS };
	return { options: { thinking: { type: "disabled" } }, thinking: "off", effort: null, room: 0 };
}

function buildOptions(settings: ModelCallSettings, jsonMode: boolean): ModelCallOptions {
	const extension = settings.kind === "triage" ? settings.extension : undefined;
	const answer =
		settings.kind === "triage" ? TRIAGE_ANSWER_TOKENS + (extension?.outputTokens ?? 0) : DRAFT_ANSWER_TOKENS;
	const factor = settings.retried ? CUT_OFF_RETRY_FACTOR : 1;
	const json: Record<string, JSONValue> = jsonMode ? { response_format: { type: "json_object" } } : {};
	const common = {
		provider: settings.provider,
		preset: settings.preset,
		kind: settings.kind,
		modelId: settings.modelId,
		reasoningEffort: settings.reasoningEffort,
		jsonMode,
		...(extension ? { extension } : {}),
		...(settings.retried ? { retried: true } : {}),
		...(settings.plainThinking ? { plainThinking: true } : {}),
	};
	if (settings.provider === "cloudflare") {
		// Kimi K2.5 ignores reasoning_effort; only switching thinking off keeps it fast and inside the budget.
		const options = { chat_template_kwargs: { thinking: false }, ...json };
		// workers-ai-provider 4 reads "workers-ai"; "workersAi" is the camel-cased key newer versions read.
		return {
			...common,
			provider: "cloudflare",
			maxOutputTokens: answer * factor,
			providerOptions: { workersAi: options, "workers-ai": options },
			reasoningEffort: null,
			effort: null,
			thinking: "off",
			thinkingRoom: 0,
		};
	}
	if (settings.preset === "anthropic") {
		const choice = anthropicThinking(settings);
		return {
			...common,
			maxOutputTokens: (answer + choice.room) * factor,
			providerOptions: { anthropic: choice.options },
			effort: choice.effort,
			thinking: choice.thinking,
			thinkingRoom: choice.room * factor,
		};
	}
	const effort = settings.reasoningEffort;
	const room = effort ? THINKING_ROOM_TOKENS : 0;
	return {
		...common,
		maxOutputTokens: (answer + room) * factor,
		providerOptions: {
			[COMPATIBLE_PROVIDER_NAME]: {
				...responseFormat(jsonMode, extension),
				...(effort ? { reasoningEffort: effort } : {}),
			},
		},
		effort,
		thinking: effort ? "on" : "default",
		thinkingRoom: room * factor,
	};
}

/** Provider-aware options and output budget for one automatic model call (never any tools). */
export function buildModelCallOptions(input: ModelCallInput): ModelCallOptions {
	const reasoningEffort = parseAgentReasoningEffort(input.reasoningEffort) ?? null;
	return buildOptions(
		{
			provider: input.provider,
			preset: input.preset ?? "openai",
			kind: input.kind,
			modelId: input.modelId ?? null,
			reasoningEffort,
			extension: input.extension,
		},
		input.kind === "triage",
	);
}

type TriageModelChoice = {
	triageModelId: string | null;
	mailboxModelId: string | null;
	models: string[];
	rates: Record<string, AgentModelRates>;
};

function knownCost(rates: AgentModelRates | undefined): number | null {
	if (!rates || rates.input === null || rates.output === null) return null;
	return rates.input + rates.output;
}

/**
 * The model automatic reading uses: the mailbox's triage model, else the cheapest configured model
 * with known rates, else the mailbox's chat model, else null for the provider default.
 */
export function chooseTriageModelId(choice: TriageModelChoice): string | null {
	const configured = (id: string | null): id is string => !!id && choice.models.includes(id);
	if (configured(choice.triageModelId)) return choice.triageModelId;
	let cheapest: { id: string; cost: number } | null = null;
	for (const id of choice.models) {
		const cost = knownCost(choice.rates[id]);
		if (cost !== null && (!cheapest || cost < cheapest.cost)) cheapest = { id, cost };
	}
	if (cheapest) return cheapest.id;
	return configured(choice.mailboxModelId) ? choice.mailboxModelId : null;
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
	if (options.reasoningEffort && /reasoning|effort/i.test(text))
		return buildOptions({ ...options, reasoningEffort: null }, options.jsonMode);
	// An Anthropic-compatible endpoint that refuses `thinking` or `effort` gets neither, with the thinking room.
	if (options.preset === "anthropic" && !options.plainThinking && /thinking|effort/i.test(text))
		return buildOptions({ ...options, plainThinking: true }, options.jsonMode);
	const rejectsFormat = /response_format|json_object|json_schema|json mode/i.test(text);
	// A provider without `json_schema` support first falls back to plain JSON mode, then to none.
	if (options.jsonMode && rejectsFormat && options.extension?.schema && options.provider !== "cloudflare")
		return buildOptions({ ...options, extension: { ...options.extension, schema: null } }, true);
	if (options.jsonMode && rejectsFormat) return buildOptions(options, false);
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

/** The facts of a cut-off attempt: what Kite sent and what the provider counted. */
export function outputBudgetOf(options: ModelCallOptions, result?: ModelCallResult): AiOutputBudget {
	const used = result?.usage?.outputTokens;
	const thinkingUsed = result?.usage?.outputTokenDetails?.reasoningTokens;
	return {
		cap: options.maxOutputTokens,
		thinkingRoom: options.thinkingRoom,
		extensionRoom: (options.extension?.outputTokens ?? 0) * (options.retried ? CUT_OFF_RETRY_FACTOR : 1),
		thinking: options.thinking,
		effort: options.effort,
		retried: !!options.retried,
		used: typeof used === "number" ? used : null,
		thinkingUsed: typeof thinkingUsed === "number" ? thinkingUsed : null,
	};
}

/** A `length` finish is a failed attempt: partial JSON is never parsed or repaired. */
export function completedText(result: ModelCallResult, options?: ModelCallOptions): string {
	if (result.finishReason === "length")
		throw new ModelOutputTruncatedError(options ? outputBudgetOf(options, result) : null);
	return result.text;
}

/** The same request with `CUT_OFF_RETRY_FACTOR` times the budget, for the one retry after a cut-off answer. */
export function widenedAfterCutOff(options: ModelCallOptions): ModelCallOptions {
	return buildOptions({ ...options, retried: true }, options.jsonMode);
}

type Generate = (prompt: TriagePrompt, options: ModelCallOptions) => Promise<ModelCallResult>;

/** One request with its parameter fallbacks, and the options that were actually sent. */
async function sentCall(prompt: TriagePrompt, options: ModelCallOptions, generate: Generate) {
	let sent = options;
	const result = await callWithFallback(options, (current) => {
		sent = current;
		return generate(prompt, current);
	});
	return { result, sent };
}

type TriageAttemptInput = {
	prompt: TriagePrompt;
	options: ModelCallOptions;
	/** The module ids of the active extensions, whose `modules` keys the parse keeps. */
	activeModuleIds?: readonly string[];
	/** The request asked for the one-line summary, which the parse then keeps when it is usable. */
	oneLine?: boolean;
	generate: Generate;
	now?: Date;
};

/**
 * One triage attempt: the model call, strict parsing and at most one repair call. A cut-off answer is asked
 * again once with a larger budget (and the repair keeps it); a second cut-off fails the attempt.
 */
export async function runTriageAttempt(input: TriageAttemptInput): Promise<{ result: TriageResult; calls: number }> {
	let options = input.options;
	let calls = 0;
	const run = async (prompt: TriagePrompt): Promise<string> => {
		calls += 1;
		const { result, sent } = await sentCall(prompt, options, input.generate);
		options = sent;
		if (result.finishReason !== "length" || options.retried) return completedText(result, options);
		options = widenedAfterCutOff(options);
		return run(prompt);
	};
	const parse = (text: string) =>
		parseTriageOutput(text, input.now, input.activeModuleIds, input.oneLine ? { oneLine: true } : {});
	const first = await run(input.prompt);
	const parsed = parse(first);
	if (parsed.ok) return { result: parsed.result, calls };
	const repaired = parse(await run(buildTriageRepairPrompt(input.prompt, first, parsed.error)));
	if (repaired.ok) return { result: repaired.result, calls };
	throw new TriageOutputError(repaired.error);
}
