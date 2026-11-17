/**
 * Output budgets of automatic AI requests and what a cut-off one leaves behind. Client-safe: Why? and Ask AI read
 * the same numbers the model call uses.
 */

/** Automatic reading's own answer, before module extensions, the one-line summary and thinking room. */
export const TRIAGE_ANSWER_TOKENS = 400;
/** A draft and a one-line summary's base. */
export const DRAFT_ANSWER_TOKENS = 900;
/** A new email from Write with Kite: a follow-up on a long thread can run to several hundred words. */
export const WRITE_ANSWER_TOKENS = 2_000;
/** The most a Write with Kite rewrite gets, and the least, whatever the length of the text. */
export const REWRITE_MAX_ANSWER_TOKENS = 4_000;
export const REWRITE_MIN_ANSWER_TOKENS = 400;
/** Shorter never needs more than the new text it asks for. */
export const SHORTER_MAX_ANSWER_TOKENS = 900;
/** One step of an assistant chat turn or an assistant-by-email request (`CHAT_STEP_MAX_OUTPUT_TOKENS`). */
export const CHAT_STEP_ANSWER_TOKENS = 1_200;
/** A summary or its translation (`SUMMARY_MAX_OUTPUT_TOKENS`). */
export const SUMMARY_ANSWER_TOKENS = 1_600;
/**
 * One part of a message translation (`TRANSLATION_CHUNK_MAX_CHARS` of source text): about 3,500 tokens for the
 * longest part in a script that takes many tokens per character, and the JSON around it.
 */
export const TRANSLATION_ANSWER_TOKENS = 4_500;
/** Added when a request thinks: a reasoning effort was set, or the model cannot stop thinking. */
export const THINKING_ROOM_TOKENS = 1_100;
/**
 * The thinking room of a request a person waits for (Write with Kite, assistant chat, the assistant by email): a
 * long thread takes more thinking than one message, and the cap is only reserved, never charged unless used.
 */
export const INTERACTIVE_THINKING_ROOM_TOKENS = 3_000;
/** The most module extensions add to a triage request (`MODULE_EXTENSION_MAX_OUTPUT_TOKENS`). */
export const TRIAGE_EXTENSION_MAX_TOKENS = 200;
/** What the one-line summary adds when it rides on the triage request (`ONE_LINE_OUTPUT_TOKENS`). */
export const TRIAGE_LINE_TOKENS = 60;
/** A cut-off answer is retried once with this many times the cap. */
export const CUT_OFF_RETRY_FACTOR = 2;

/**
 * How a request's thinking was set: switched off, at Claude Sonnet 5.5's lowest setting (`between_tools`, no
 * thinking before the answer), asked for with an effort, or left to the provider's default.
 */
export type AiThinkingSetting = "off" | "between_tools" | "on" | "default";

/**
 * What Kite sent and what the provider reported for a request that was cut off: numbers and settings, never
 * content. Key names avoid "token", which the logger redacts.
 */
export type AiOutputBudget = {
	/** The output cap of the last attempt (`max_tokens`), thinking included. */
	cap: number;
	/** The part of the cap Kite added for thinking. */
	thinkingRoom: number;
	/** The part active module extensions and the one-line summary added. */
	extensionRoom: number;
	thinking: AiThinkingSetting;
	/** The reasoning effort sent, if any. */
	effort: string | null;
	/** Kite already retried once with a larger cap. */
	retried: boolean;
	/** The output tokens the provider counted for the attempt, and how many were thinking, when it said. */
	used: number | null;
	thinkingUsed: number | null;
};

/**
 * How a Claude model thinks when the request sends no `thinking` setting: `off` (it does not), `adaptive` (it
 * thinks, and `thinking: disabled` turns that off), `between_tools` (it thinks and rejects `disabled`; its lowest
 * setting, `between_tools`, skips thinking before the answer) or `always` (it cannot be turned off; only a lower
 * effort helps). An unknown, newer Claude is taken to think by default.
 */
export function claudeThinkingDefault(
	modelId: string | null | undefined,
): "off" | "adaptive" | "between_tools" | "always" {
	const id = (modelId ?? "").toLowerCase();
	if (/claude-(opus-5-5|fable-5|mythos-5)/.test(id)) return "always";
	// Claude Sonnet 5.5 answers `thinking: disabled` with a 400 (@ai-sdk/anthropic 4.0.87 swaps it for between_tools).
	if (/claude-sonnet-5-5/.test(id)) return "between_tools";
	if (/claude-(haiku|sonnet|opus)-5/.test(id)) return "adaptive";
	if (/claude-(haiku|sonnet|opus)-4|claude-(3|2|instant)/.test(id)) return "off";
	return "adaptive";
}

/**
 * The most a Workers AI request is widened to when its cut-off answer is asked once more: some Workers AI models
 * refuse a larger `max_tokens`. A first request above it keeps its own cap.
 */
export const WORKERS_AI_RETRY_MAX_TOKENS = 4_000;

/**
 * Whether a model behind an OpenAI-compatible endpoint is known to reason before it answers, from its id: OpenAI's
 * o-series and GPT-5, DeepSeek R1 and its reasoner, QwQ and Qwen3, Kimi K2, GLM 4.5 and later, Grok 3 and 4, Gemini
 * 2.5 and later, Magistral, any id that says it reasons or thinks, and Claude 5 through a router. Only these get the
 * thinking room in a chat step, so a small model behind such an endpoint keeps the cap it always had.
 */
export function knownToReason(modelId: string | null | undefined): boolean {
	const id = (modelId ?? "").toLowerCase();
	if (/claude/.test(id)) return claudeThinkingDefault(id.replace(/^.*\//, "")) !== "off";
	return /(^|[/:._-])(o[1-9]([-.]|$)|gpt-5|deepseek-(r1|reasoner)|qwq|qwen3|kimi-k2|glm-(4\.[5-9]|[5-9])|grok-[34]|gemini-(2\.5|[3-9])|magistral)|reason|think/.test(
		id,
	);
}

/** Whether a recorded provider and model think by default, or null when Kite cannot tell (any other provider). */
export function thinksByDefault(provider: string | null, model: string | null): boolean | null {
	if (provider !== "anthropic" || !model) return null;
	return claudeThinkingDefault(model) !== "off";
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A stored budget read back defensively, or null for an older row without one. */
export function readAiOutputBudget(value: unknown): AiOutputBudget | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const cap = number(raw.cap);
	if (cap === null) return null;
	const thinking =
		raw.thinking === "off" || raw.thinking === "between_tools" || raw.thinking === "on" ? raw.thinking : "default";
	return {
		cap,
		thinkingRoom: number(raw.thinkingRoom) ?? 0,
		extensionRoom: number(raw.extensionRoom) ?? 0,
		thinking,
		effort: typeof raw.effort === "string" ? raw.effort : null,
		retried: raw.retried === true,
		used: number(raw.used),
		thinkingUsed: number(raw.thinkingUsed),
	};
}

const count = (value: number) => value.toLocaleString("en-US");

/** "1,600 tokens (400 for the answer + 1,100 for thinking + 100 for module extensions)". */
export function describeOutputCap(budget: AiOutputBudget): string {
	const answer = Math.max(0, budget.cap - budget.thinkingRoom - budget.extensionRoom);
	const parts = [`${count(answer)} for the answer`];
	if (budget.thinkingRoom > 0) parts.push(`${count(budget.thinkingRoom)} for thinking`);
	if (budget.extensionRoom > 0) parts.push(`${count(budget.extensionRoom)} for module extensions`);
	return `${count(budget.cap)} tokens${parts.length > 1 ? ` (${parts.join(" + ")})` : ""}`;
}

/** "off", "on at effort low" or "left to the provider's default". */
export function describeThinking(budget: Pick<AiOutputBudget, "thinking" | "effort">): string {
	if (budget.thinking === "off") return "off";
	if (budget.thinking === "between_tools") return "at its lowest setting (between_tools: none before the answer)";
	if (budget.thinking === "on") return budget.effort ? `on at effort ${budget.effort}` : "on";
	return "left to the provider's default";
}

/** "used 1,600 output tokens, 1,580 of them thinking", or null when the provider reported nothing. */
export function describeUsage(budget: AiOutputBudget): string | null {
	if (budget.used === null) return null;
	const thinking = budget.thinkingUsed ? `, ${count(budget.thinkingUsed)} of them thinking` : "";
	return `used ${count(budget.used)} output tokens${thinking}`;
}
