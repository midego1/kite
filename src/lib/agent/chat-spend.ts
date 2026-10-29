import type { LanguageModelUsage } from "ai";
import type { AiUsageDetails } from "@/lib/ai/usage-types";
import { keepReservedEstimate, reconcileAiSpend, refusedSpendCap, reserveAiSpend } from "./auto-read/spend";
import type { ReserveAiSpendInput, SpendCapKind, SpendReservation } from "./auto-read/spend-types";
import { CHAT_STEP_MAX_OUTPUT_TOKENS, spendCapMessage } from "./chat-spend-utils";

/** A chat step was refused because it would pass a daily cap; the message names the cap. */
export class ChatSpendCapError extends Error {
	constructor(
		message: string,
		readonly cap: SpendCapKind,
	) {
		super(message);
		this.name = "ChatSpendCapError";
	}
}

/** The cap refusal behind `error`, also when the SDK wrapped it as another error's cause. */
export function chatSpendCapError(error: unknown): ChatSpendCapError | null {
	for (let depth = 0; depth < 4 && error; depth += 1) {
		if (error instanceof ChatSpendCapError) return error;
		error = error instanceof Error ? error.cause : null;
	}
	return null;
}

type ChatSpendInput = {
	env: CloudflareEnv;
	details: AiUsageDetails;
	mailboxId: string;
	installCapMicros: number;
	mailboxCapMicros: number | null;
	/** Chat's own daily input-token allowance, used when the model has no rates. */
	tokenCap: number;
};

/**
 * Per-step spend for one chat turn, as for automatic reading: `beforeStep` reserves the step's estimate
 * against the caps (throwing `ChatSpendCapError` when it would pass one), `afterStep` reconciles it with the
 * step's usage, and `settle` closes a reservation whose step never finished, keeping its estimate.
 */
export function createChatSpend(input: ChatSpendInput) {
	let pending: SpendReservation | null = null;
	const take = () => {
		const reservation = pending;
		pending = null;
		return reservation;
	};
	// A step that never finished keeps its estimate: stopped, or failed with the turn's error code.
	const settle = async (errorCode?: string | null) => {
		const reservation = take();
		if (reservation)
			await keepReservedEstimate(input.env, reservation, errorCode ? { status: "failed", errorCode } : undefined);
	};
	return {
		async beforeStep(promptChars: number): Promise<void> {
			await settle();
			const request: ReserveAiSpendInput = {
				...input,
				source: "chat",
				jobId: null,
				promptChars,
				maxOutputTokens: CHAT_STEP_MAX_OUTPUT_TOKENS,
			};
			const reservation = await reserveAiSpend(request);
			if (!reservation) {
				const cap = await refusedSpendCap(request);
				throw new ChatSpendCapError(spendCapMessage(cap, input), cap);
			}
			pending = reservation;
		},
		async afterStep(usage: LanguageModelUsage | undefined, finishReason?: string | null): Promise<void> {
			const reservation = take();
			if (reservation)
				await reconcileAiSpend({
					env: input.env,
					reservation,
					rates: input.details.rates,
					usage,
					outcome: { status: usage ? "ok" : "failed", finishReason: finishReason ?? null },
				});
		},
		settle,
	};
}
