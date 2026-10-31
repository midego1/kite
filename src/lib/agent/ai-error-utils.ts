/**
 * The one list of ways an AI request can fail, shared by chat, Write with Kite, summaries, translation, automatic
 * reading and agent drafts. Each failure gets a stable code and a sentence that says what happened and what to do;
 * the provider's own error text is never shown, since it can echo the prompt. Client-safe: no server imports.
 */

import { readAiOutputBudget, type AiOutputBudget } from "./output-budget-utils";

const AI_ERROR_CODES = [
	"timeout",
	"cut_off",
	"provider_rejected",
	"provider_auth",
	"provider_unavailable",
	"provider_error",
	"provider_rate_limited",
	"model_unavailable",
	"context_too_long",
	"unusable_answer",
	"spend_cap",
	"rate_limited",
	"external_provider_not_allowed",
	"assistant_off",
	"no_provider",
	"provider_key_unreadable",
	"network",
	"internal",
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/** The feature a request belongs to, as logs and the admin list name it. */
export type AiFeature =
	"chat" | "compose" | "summary" | "summary_translation" | "auto_triage" | "auto_draft" | "line_summary";

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
	chat: "Assistant chat",
	compose: "Write with Kite",
	summary: "Summary",
	summary_translation: "Summary translation",
	auto_triage: "Automatic reading",
	auto_draft: "Agent draft",
	line_summary: "One-line summary",
};

/** What the UI shows under Details: never a secret, a prompt or an answer. */
export type AiErrorDetails = {
	code: AiErrorCode;
	feature: AiFeature;
	model: string | null;
	provider: string | null;
	/** The provider's HTTP status, when it answered with one. */
	status: number | null;
	/** ISO time of the failure. */
	at: string;
	retryable: boolean;
	/** A setting in Admin → Agent can fix it. */
	config: boolean;
};

/** The JSON body (or stream event fields) of a failed AI request. */
export type AiErrorBody = { error: string; code: AiErrorCode; details: AiErrorDetails };

export type AiErrorClass = {
	code: AiErrorCode;
	status: number | null;
	reason?: string;
	/** A cut-off answer's cap, thinking setting and usage, when the code that sent it knew them. */
	budget?: AiOutputBudget | null;
};

/** Thrown when the model answered but the answer failed Kite's checks; `reason` is plain words. */
export class UnusableAnswerError extends Error {
	constructor(readonly reason: string) {
		super(`The answer was not usable: ${reason}`);
		this.name = "UnusableAnswerError";
	}
}

const RETRYABLE = new Set<AiErrorCode>([
	"timeout",
	"cut_off",
	"provider_unavailable",
	"provider_error",
	"provider_rate_limited",
	"unusable_answer",
	"rate_limited",
	"network",
	"internal",
]);

const CONFIG = new Set<AiErrorCode>([
	"provider_rejected",
	"provider_auth",
	"model_unavailable",
	"context_too_long",
	"external_provider_not_allowed",
	"assistant_off",
	"no_provider",
	"provider_key_unreadable",
]);

/** Refused by Kite before any provider call: a cap, a rate limit or a setting, not a provider or model failure. */
const REFUSALS_BEFORE_CALL = new Set<AiErrorCode>([
	"spend_cap",
	"rate_limited",
	"external_provider_not_allowed",
	"assistant_off",
	"no_provider",
	"provider_key_unreadable",
]);

export function aiErrorIsRefusal(code: AiErrorCode): boolean {
	return REFUSALS_BEFORE_CALL.has(code);
}

export function isAiErrorCode(value: unknown): value is AiErrorCode {
	return typeof value === "string" && (AI_ERROR_CODES as readonly string[]).includes(value);
}

export function aiErrorRetryable(code: AiErrorCode): boolean {
	return RETRYABLE.has(code);
}

/** Whether an admin can fix it in Admin → Agent. */
export function aiErrorIsConfig(code: AiErrorCode): boolean {
	return CONFIG.has(code);
}

type MessageInput = { timeoutMs?: number | null; status?: number | null; reason?: string | null };

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
const http = (status: number | null | undefined) => (status ? ` (HTTP ${status})` : "");

const MESSAGES: Record<AiErrorCode, (input: MessageInput) => string> = {
	timeout: ({ timeoutMs }) =>
		`The AI took too long${timeoutMs ? ` (${seconds(timeoutMs)})` : ""}. Try again, or pick a faster model in Admin → Agent.`,
	cut_off: () =>
		"The AI's answer was cut off before it was finished. Try again; if it keeps happening, pick another model in Admin → Agent.",
	provider_rejected: ({ status }) =>
		`The AI provider refused the request${http(status)}. Check the provider and model in Admin → Agent.`,
	provider_auth: ({ status }) =>
		`The AI provider did not accept Kite's API key${http(status)}. Update the key in Admin → Agent.`,
	provider_unavailable: ({ status }) =>
		`The AI provider had a problem on its side${http(status)}. Try again in a moment.`,
	provider_error: () => "The AI provider returned an error. Try again in a moment.",
	provider_rate_limited: ({ status }) =>
		`The AI provider is busy or rate-limited${http(status ?? 429)}. Wait a moment and try again.`,
	model_unavailable: () => "The AI model is not available at the provider. Pick another model in Admin → Agent.",
	context_too_long: () =>
		"This is too long for the AI model to read at once. Pick a model with a larger context in Admin → Agent.",
	unusable_answer: ({ reason }) => `The AI's answer wasn't usable${reason ? `: ${reason}` : ""}. Try again.`,
	spend_cap: () =>
		"The daily AI spend cap or allowance is reached. It resets at 00:00 UTC; the primary admin can change it in Admin → Agent.",
	rate_limited: () => "Too many AI requests at once. Wait a moment and try again.",
	external_provider_not_allowed: () =>
		"The primary admin has not allowed the external AI provider to read mail. They can allow it in Admin → Agent.",
	assistant_off: () => "The assistant is turned off. An admin can turn it on in Admin → Agent.",
	no_provider: () => "No AI provider is set up. An admin can set one up in Admin → Agent.",
	provider_key_unreadable: () =>
		"The AI provider's saved API key can't be read (APP_ENCRYPTION_KEY may have changed). The primary admin can enter it again in Admin → Agent.",
	network: () => "Kite could not reach the AI provider. Try again in a moment.",
	internal: () =>
		"Something went wrong in Kite while asking the AI. Try again; if it keeps happening, the primary admin can see the error in Admin → Agent.",
};

/** The sentence a person sees for a failure: what happened, then what to do. */
export function aiErrorMessage(code: AiErrorCode, input: MessageInput = {}): string {
	return MESSAGES[code](input);
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function nameOf(error: unknown): string {
	const name = record(error)?.name;
	return typeof name === "string" ? name : "";
}

function textOf(error: unknown): string {
	const value = record(error);
	const message = typeof value?.message === "string" ? value.message : typeof error === "string" ? error : "";
	const body = typeof value?.responseBody === "string" ? value.responseBody : "";
	return `${message} ${body}`;
}

function statusOf(error: unknown): number | null {
	const value = record(error);
	for (const candidate of [value?.statusCode, value?.status, record(value?.cause)?.statusCode]) {
		if (typeof candidate === "number" && candidate >= 400 && candidate < 600) return candidate;
	}
	return null;
}

/** Workers AI's own error number, which workers-ai-provider keeps in `data.workersAIErrorCode`. */
function workersAiCode(error: unknown): number | null {
	const code = record(record(error)?.data)?.workersAIErrorCode;
	return typeof code === "number" ? code : null;
}

const CONTEXT_TOO_LONG =
	/context.{0,20}(length|window|limit)|maximum context|too many (input )?tokens|prompt is too long|input is too long/i;
const MODEL_MISSING = /no such model|model.{0,40}(not found|does not exist|not available|unavailable)|unknown model/i;
const NETWORK =
	/cannot connect to api|fetch failed|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|connection (lost|closed|reset)/i;
// Workers AI codes: 5007 no such model, 3042 model not found; 3006 request too large; 3007/3008 timeouts.
const WORKERS_AI_MODEL_MISSING = new Set([5007, 3042]);

function fromStatus(status: number, error: unknown): AiErrorClass {
	const text = textOf(error);
	if (status === 401 || status === 403) return { code: "provider_auth", status };
	if (status === 404 || WORKERS_AI_MODEL_MISSING.has(workersAiCode(error) ?? 0))
		return { code: "model_unavailable", status };
	if (status === 408 || status === 504) return { code: "timeout", status };
	if (status === 413 || CONTEXT_TOO_LONG.test(text)) return { code: "context_too_long", status };
	if (status === 429) return { code: "provider_rate_limited", status };
	if (status >= 500) return { code: "provider_unavailable", status };
	if (MODEL_MISSING.test(text)) return { code: "model_unavailable", status };
	return { code: "provider_rejected", status };
}

const REFUSALS: Record<string, AiErrorCode> = {
	assistant_disabled: "assistant_off",
	not_configured: "no_provider",
	provider_key_unreadable: "provider_key_unreadable",
	external_provider_not_allowed: "external_provider_not_allowed",
};

/** Kite's own errors, recognised by name so this file needs no server import. */
const KITE_ERRORS: Record<string, (error: unknown) => AiErrorClass> = {
	UnusableAnswerError: (error) => ({
		code: "unusable_answer",
		status: null,
		reason: (error as UnusableAnswerError).reason,
	}),
	TriageOutputError: () => ({
		code: "unusable_answer",
		status: null,
		reason: "it was not in the format Kite asked for",
	}),
	ModelOutputTruncatedError: (error) => ({
		code: "cut_off",
		status: null,
		budget: readAiOutputBudget(record(error)?.budget),
	}),
	SpendCapReachedError: () => ({ code: "spend_cap", status: null }),
	ChatSpendCapError: () => ({ code: "spend_cap", status: null }),
	ExternalProviderNotAllowedError: () => ({ code: "external_provider_not_allowed", status: null }),
	AgentProviderKeyUnreadableError: () => ({ code: "provider_key_unreadable", status: null }),
	InteractiveModelRefusedError: (error) => {
		const reason = record(error)?.reason;
		return { code: (typeof reason === "string" && REFUSALS[reason]) || "no_provider", status: null };
	},
	TimeoutError: () => ({ code: "timeout", status: null }),
};

/** A failure without an HTTP status, told apart by the Workers AI error number or the error's text. */
function withoutStatus(error: unknown): AiErrorCode {
	const code = workersAiCode(error);
	const text = textOf(error);
	if (code && WORKERS_AI_MODEL_MISSING.has(code)) return "model_unavailable";
	if (code === 3006 || CONTEXT_TOO_LONG.test(text)) return "context_too_long";
	if (code === 3007 || code === 3008) return "timeout";
	if (NETWORK.test(text)) return "network";
	// An API call error without a status: the provider (or the Workers AI binding) failed and said why only in text.
	if (nameOf(error) === "AI_APICallError" || record(error)?.url !== undefined) return "provider_error";
	return "internal";
}

/**
 * The code of any error an AI request can end with. The provider's text is read only to tell a too-long prompt, a
 * missing model or a network failure apart; it is never shown.
 */
export function classifyAiError(error: unknown): AiErrorClass {
	const known = KITE_ERRORS[nameOf(error)];
	if (known) return known(error);
	if (nameOf(record(error)?.cause) === "TimeoutError") return { code: "timeout", status: null };
	// The SDK's retry wrapper keeps the last error; classify that one.
	const last = record(error)?.lastError;
	if (nameOf(error) === "AI_RetryError" && last) return classifyAiError(last);
	const status = statusOf(error);
	return status ? fromStatus(status, error) : { code: withoutStatus(error), status: null };
}

/** The HTTP status a route answers a failed AI request with. */
export function aiErrorHttpStatus(code: AiErrorCode): number {
	switch (code) {
		case "timeout":
			return 504;
		case "spend_cap":
		case "rate_limited":
			return 429;
		case "assistant_off":
		case "external_provider_not_allowed":
			return 403;
		case "no_provider":
		case "provider_key_unreadable":
		case "provider_rate_limited":
			return 503;
		case "internal":
			return 500;
		default:
			return 502;
	}
}

/** The details of a failure as a client received them, or null for any other body. */
export function readAiErrorBody(value: unknown): AiErrorBody | null {
	const body = record(value);
	const details = record(body?.details);
	const code = body?.code;
	if (typeof body?.error !== "string" || !isAiErrorCode(code) || !details) return null;
	const text = (key: string) => (typeof details[key] === "string" ? (details[key] as string) : null);
	const feature = text("feature");
	return {
		error: body.error,
		code,
		details: {
			code,
			feature: (feature && feature in AI_FEATURE_LABELS ? feature : "chat") as AiFeature,
			model: text("model"),
			provider: text("provider"),
			status: typeof details.status === "number" ? details.status : null,
			at: text("at") ?? new Date().toISOString(),
			retryable: aiErrorRetryable(code),
			config: aiErrorIsConfig(code),
		},
	};
}

/** What went wrong, as the end of a sentence in Activity ("… because it took too long"). */
const CAUSES: Record<AiErrorCode, string> = {
	timeout: "it took too long",
	cut_off: "its answer was cut off",
	provider_rejected: "the provider refused the request",
	provider_auth: "the provider did not accept the API key",
	provider_unavailable: "the provider had a problem on its side",
	provider_error: "the provider returned an error",
	provider_rate_limited: "the provider was busy or rate-limited",
	model_unavailable: "the model is not available",
	context_too_long: "the email was too long for the model",
	unusable_answer: "its answer was not usable",
	spend_cap: "the spend cap was reached",
	rate_limited: "there were too many requests at once",
	external_provider_not_allowed: "the external provider is not allowed to read mail",
	assistant_off: "the assistant is turned off",
	no_provider: "no AI provider is set up",
	provider_key_unreadable: "the AI provider's saved API key can't be read",
	network: "Kite could not reach the provider",
	internal: "Kite hit an unexpected error",
};

/** The reason a failed agent job stores: `ai_error:<code>`, which Activity puts in words. */
export function aiJobReason(code: AiErrorCode): string {
	return `ai_error:${code}`;
}

/** The reason of a job that went on without the model after it failed: `model_failed:<code>`. */
export function modelFailedReason(code: AiErrorCode): string {
	return `model_failed:${code}`;
}

/** The words for a stored `ai_error:<code>` or `model_failed:<code>` reason, or null for any other reason. */
export function aiReasonText(reason: string): string | null {
	const match = /^(ai_error|model_failed):([a-z_]+)$/.exec(reason);
	if (!match || !isAiErrorCode(match[2])) return null;
	const cause = `${CAUSES[match[2]]} (${match[2]})`;
	return match[1] === "ai_error"
		? `Failed: the AI request did not work because ${cause}`
		: `The AI model did not answer because ${cause}; the message was checked without it`;
}
