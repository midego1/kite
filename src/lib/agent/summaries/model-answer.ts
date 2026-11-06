import { generateText, type LanguageModelUsage } from "ai";
import { getDb } from "@/db";
import { reportAiErrorClass } from "../ai-errors";
import { aiErrorHttpStatus, classifyAiError, UnusableAnswerError, type AiErrorDetails } from "../ai-error-utils";
import { getAutoReadInstallSettings } from "../auto-read/install-settings";
import { readMailboxAgentSettingsRow } from "../auto-read/mailbox-settings";
import { buildModelCallOptions, callWithFallback, completedText } from "../auto-read/model-call-utils";
import {
	finishReasonOf,
	keepReservedEstimate,
	reconcileAiSpend,
	refusedSpendCap,
	reserveAiSpend,
} from "../auto-read/spend";
import type { AutoSpendSource, ReserveAiSpendInput } from "../auto-read/spend-types";
import { spendCapMessage } from "../chat-spend-utils";
import { selectInteractiveModel } from "../interactive-model";
import { aiCallTimeoutMs } from "../provider-url-utils";
import { buildSummaryRepairPrompt } from "./summary-prompt-utils";
import type { SummaryPrompt } from "./summary-types";

/**
 * A request answered with its status and a code before or instead of a saved answer; a failed AI request also
 * carries the details the reader shows under Details.
 */
export class SummaryRefusal extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code: string,
		readonly details?: AiErrorDetails,
	) {
		super(message);
		this.name = "SummaryRefusal";
	}
}

export const NO_STORE = { "Cache-Control": "no-store" };

/** The answer of a route to a `SummaryRefusal`; anything else is not a refusal and is thrown on. */
export function refused(error: unknown): Response {
	if (error instanceof SummaryRefusal)
		return Response.json(
			{ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) },
			{ status: error.status, headers: NO_STORE },
		);
	throw error;
}

/** The reservation was refused at a cap; the message names which one. */
class SpendCapRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpendCapReachedError";
	}
}

/** A provider's HTTP status when it refused the request outright (a 4xx), which costs nothing. */
function rejectedOutright(error: unknown): boolean {
	const status = (error as { statusCode?: unknown } | null)?.statusCode;
	return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * Reserves the spend of one request, or refuses with the message that names the cap. A call that fails without
 * reporting usage (a timeout, an abort, a dropped connection) keeps its estimate as the recorded spend, as compose
 * and chat do; only a request the provider refused outright is settled at zero.
 */
async function reserved<T extends { usage: LanguageModelUsage | undefined }>(
	reserve: ReserveAiSpendInput,
	call: () => Promise<T>,
) {
	const reservation = await reserveAiSpend(reserve);
	if (!reservation) throw new SpendCapRefusal(spendCapMessage(await refusedSpendCap(reserve), reserve));
	let result: T;
	try {
		result = await call();
	} catch (error) {
		const outcome = { status: "failed", errorCode: classifyAiError(error).code } as const;
		if (rejectedOutright(error))
			await reconcileAiSpend({ env: reserve.env, reservation, rates: reserve.details.rates, outcome });
		else await keepReservedEstimate(reserve.env, reservation, outcome);
		throw error;
	}
	await reconcileAiSpend({
		env: reserve.env,
		reservation,
		rates: reserve.details.rates,
		usage: result.usage,
		outcome: { status: "ok", finishReason: finishReasonOf(result) },
	});
	return result;
}

type ModelSelection = Awaited<ReturnType<typeof selectInteractiveModel>>;

/** What the last model request of an answer said, for the log line of a failure. */
type CallTrace = {
	modelId: string | null;
	provider: string | null;
	usage: LanguageModelUsage | null;
	finishReason: string | null;
};

export type CheckedAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

type CheckedModelRequest<T> = {
	env: CloudflareEnv;
	userId: string;
	mailboxId: string;
	source: Extract<AutoSpendSource, "summary" | "summary_translation" | "message_translation">;
	prompt: SummaryPrompt;
	/** The answer's own output budget, before any thinking room. */
	answerTokens: number;
	timeoutMs: number;
	check: (text: string) => CheckedAnswer<T>;
	/** What `check` found wrong, in plain words for the reader. */
	problemText: (error: string) => string;
};

/**
 * One answer from the model: the model chosen and the opt-in checked again for every request (the repair turn too),
 * each request's estimate reserved against the mailbox and install caps and settled with its usage, the answer
 * checked by code. An unusable answer gets one repair turn; a second one is an error. Every failure is logged once
 * and answered with its own code and message (`ai-error-utils.ts`).
 */
export async function checkedModelAnswer<T>(input: CheckedModelRequest<T>): Promise<{ value: T; modelId: string }> {
	const db = getDb(input.env);
	const settings = await readMailboxAgentSettingsRow(db, input.mailboxId);
	const install = await getAutoReadInstallSettings(input.env);
	const timeoutMs = aiCallTimeoutMs(input.env, process.env.NODE_ENV, input.timeoutMs);
	const startedAt = Date.now();
	const trace: CallTrace = { modelId: null, provider: null, usage: null, finishReason: null };
	const call = async (prompt: SummaryPrompt) => {
		const selection: ModelSelection = await selectInteractiveModel(input.env, {
			mailboxId: input.mailboxId,
			modelId: settings?.modelId,
		});
		trace.modelId = selection.modelId;
		trace.provider = selection.provider;
		const options = buildModelCallOptions({
			provider: selection.providerKind,
			preset: selection.preset,
			kind: "draft",
			modelId: selection.modelId,
			// The request's own budget, which a parameter fallback keeps; a thinking request's room comes on top.
			answerTokens: input.answerTokens,
			reasoningEffort: selection.reasoningEffort,
		});
		let sent = options;
		const result = await callWithFallback(options, (current) => {
			sent = current;
			return reserved(
				{
					env: input.env,
					details: selection,
					source: input.source,
					mailboxId: input.mailboxId,
					jobId: null,
					promptChars: prompt.system.length + prompt.messages.reduce((sum, message) => sum + message.content.length, 0),
					maxOutputTokens: current.maxOutputTokens,
					installCapMicros: install.dailySpendCapMicros,
					mailboxCapMicros: settings?.dailySpendCapMicros ?? null,
					tokenCap: install.chatTokenCap,
				},
				() =>
					generateText({
						model: selection.model,
						system: prompt.system,
						messages: prompt.messages,
						maxOutputTokens: current.maxOutputTokens,
						providerOptions: current.providerOptions,
						maxRetries: 0,
						abortSignal: AbortSignal.timeout(timeoutMs),
					}),
			);
		});
		trace.usage = result.usage ?? null;
		trace.finishReason = result.finishReason;
		return { text: completedText(result, sent), modelId: selection.modelId };
	};
	try {
		const first = await call(input.prompt);
		const parsed = input.check(first.text);
		if (parsed.ok) return { value: parsed.value, modelId: first.modelId };
		const second = await call(buildSummaryRepairPrompt(input.prompt, first.text, parsed.error));
		const repaired = input.check(second.text);
		if (repaired.ok) return { value: repaired.value, modelId: second.modelId };
		throw new UnusableAnswerError(input.problemText(repaired.error));
	} catch (error) {
		if (error instanceof SummaryRefusal) throw error;
		const failure = classifyAiError(error);
		const body = await reportAiErrorClass(
			error instanceof SpendCapRefusal ? { ...failure, message: error.message } : failure,
			{
				env: input.env,
				feature: input.source,
				model: trace.modelId,
				provider: trace.provider,
				startedAt,
				usage: trace.usage,
				finishReason: trace.finishReason,
				timeoutMs,
				userId: input.userId,
				mailboxId: input.mailboxId,
			},
		);
		throw new SummaryRefusal(aiErrorHttpStatus(body.code), body.error, body.code, body.details);
	}
}
