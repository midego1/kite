import type { LanguageModelUsage, streamText } from "ai";
import type { AiErrorBody, AiErrorClass } from "./ai-error-utils";
import type { AiUsageOutcome } from "@/lib/ai/usage-types";
import {
	outputBudgetOf,
	retriesAfterCutOff,
	widenedAfterCutOff,
	type ModelCallOptions,
} from "./auto-read/model-call-utils";
import type { SpendReservation } from "./auto-read/spend-types";
import { checkComposeOutput } from "./compose-output-utils";

/** What one failure report knows besides the code: when the attempt started, its usage and finish reason. */
type ComposeFailureContext = {
	startedAt: number;
	usage: LanguageModelUsage | null;
	finishReason?: string | null;
};

type SettleOutcome = Pick<AiUsageOutcome, "status" | "errorCode" | "finishReason">;

/**
 * Everything the stream does outside itself, passed in by `createComposeStream`, so a test can drive the stream
 * against a fake provider: the provider call, the spend reservation of the retry and its settlement, and the
 * failure reports (`reportAiErrorClass`, `reportAiFailure`).
 */
export type ComposeStreamInput = {
	abort: AbortController;
	check: Parameters<typeof checkComposeOutput>[1];
	first: ComposeAttempt;
	send: (options: ModelCallOptions) => ReturnType<typeof streamText>;
	/** A reservation for the retry, or the error body of the cap that refused it. */
	reserve: (options: ModelCallOptions) => Promise<SpendReservation | AiErrorBody>;
	settle: (reservation: SpendReservation, usage: LanguageModelUsage, outcome: SettleOutcome) => Promise<void>;
	/** Keeps the reserved estimate as the spend of an attempt that never reported usage. */
	keepEstimate: (
		reservation: SpendReservation,
		outcome?: Pick<AiUsageOutcome, "status" | "errorCode">,
	) => Promise<void>;
	report: (failure: AiErrorClass, context: ComposeFailureContext) => Promise<AiErrorBody>;
	reportError: (error: unknown, context: ComposeFailureContext) => Promise<AiErrorBody>;
	classify: (error: unknown) => AiErrorClass;
};

type ComposeAttempt = { options: ModelCallOptions; reservation: SpendReservation };

type Emit = (event: unknown) => void;

/**
 * One attempt: streams its deltas, settles its spend and either finishes the answer (`done` or `error`) or, when
 * the answer was cut off on the first attempt, returns the options to ask again with.
 */
async function streamAttempt(
	input: ComposeStreamInput,
	attempt: ComposeAttempt,
	emit: Emit,
): Promise<ModelCallOptions | null> {
	const startedAt = Date.now();
	const result = input.send(attempt.options);
	let settled = false;
	let usage: LanguageModelUsage | null = null;
	let errorCode: string | null = null;
	// The client gets a fixed message, a code and the details; the provider's own text, which may echo
	// content, is neither sent nor logged.
	const fail = async (body: Promise<AiErrorBody>) => emit({ type: "error", ...(await body) });
	const context = (finishReason?: string): ComposeFailureContext => ({ startedAt, usage, finishReason });
	try {
		let text = "";
		for await (const part of result.fullStream) {
			if (part.type === "text-delta") {
				text += part.text;
				emit({ type: "text", text: part.text });
			} else if (part.type === "error") throw part.error;
		}
		if (input.abort.signal.aborted) return null;
		usage = await result.totalUsage;
		const finishReason = await result.finishReason;
		// An answer that ran out of tokens ends mid-sentence; none of it may be inserted. The usage row records it
		// as cut off (`settledOutcome`), and an answer that fails Kite's checks as unusable.
		const cutOff = finishReason === "length";
		const checked = cutOff ? null : checkComposeOutput(text, input.check);
		await input.settle(
			attempt.reservation,
			usage,
			checked && !checked.ok
				? { status: "failed", errorCode: "unusable_answer", finishReason }
				: { status: "ok", finishReason },
		);
		settled = true;
		if (!checked) {
			if (retriesAfterCutOff(finishReason, attempt.options)) return widenedAfterCutOff(attempt.options);
			const budget = outputBudgetOf(attempt.options, { text, finishReason, usage });
			await fail(input.report({ code: "cut_off", status: null, budget }, context(finishReason)));
		} else if (checked.ok) emit({ type: "done", text: checked.text, warnings: checked.warnings });
		else await fail(input.report({ code: "unusable_answer", status: null, reason: checked.error }, context()));
	} catch (error) {
		if (!input.abort.signal.aborted) {
			errorCode = input.classify(error).code;
			await fail(input.reportError(error, context()));
		}
	} finally {
		// Aborted, cancelled or failed before the provider reported usage: the estimate stays as the spend.
		const outcome = errorCode ? ({ status: "failed", errorCode } as const) : undefined;
		if (!settled) await input.keepEstimate(attempt.reservation, outcome).catch(() => undefined);
	}
	return null;
}

/**
 * The composer's NDJSON stream: `text` deltas for the preview, then one checked `done` text or an `error`. A cut-off
 * first answer is asked once more with `CUT_OFF_RETRY_FACTOR` times the budget, reserved against the caps like the
 * first, after a `restart` event that tells the client to clear the preview; a second cut-off fails with `cut_off`
 * and its budget under Details. Nothing but the `ai_usage` rows is stored.
 */
export function streamComposeAnswer(input: ComposeStreamInput) {
	const encoder = new TextEncoder();
	let closed = false;
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			// Nothing is written after the reader cancelled.
			const emit: Emit = (event) => {
				if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			};
			try {
				let attempt: ComposeAttempt | null = input.first;
				while (attempt) {
					const widened = await streamAttempt(input, attempt, emit);
					attempt = null;
					if (!widened || input.abort.signal.aborted) break;
					let reservation: SpendReservation | AiErrorBody;
					try {
						reservation = await input.reserve(widened);
					} catch (error) {
						// A failed check or reservation (a database error) is answered and logged like a failed attempt.
						emit({ type: "error", ...(await input.reportError(error, { startedAt: Date.now(), usage: null })) });
						break;
					}
					if ("error" in reservation) emit({ type: "error", ...reservation });
					// Cancelled while the retry was being reserved: it never starts, and its estimate stays as the spend.
					else if (input.abort.signal.aborted) await input.keepEstimate(reservation).catch(() => undefined);
					else {
						emit({ type: "restart" });
						attempt = { options: widened, reservation };
					}
				}
			} finally {
				if (!closed) controller.close();
				closed = true;
			}
		},
		cancel() {
			closed = true;
			input.abort.abort();
		},
	});
}
