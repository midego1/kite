import type { LanguageModelUsage } from "ai";
import type { AiUsageDetails } from "@/lib/ai/usage-types";
import { keepReservedEstimate, reconcileAiSpend, reserveAiSpend } from "./auto-read/spend";
import type { SpendReservation } from "./auto-read/spend-types";
import { CHAT_STEP_MAX_OUTPUT_TOKENS, SPEND_CAP_MESSAGE } from "./chat-spend-utils";

/** A chat step was refused because it would pass the install or mailbox daily spend cap. */
export class ChatSpendCapError extends Error {
	constructor() {
		super(SPEND_CAP_MESSAGE);
		this.name = "ChatSpendCapError";
	}
}

type ChatSpendInput = {
	env: CloudflareEnv;
	details: AiUsageDetails;
	mailboxId: string;
	installCapMicros: number;
	mailboxCapMicros: number | null;
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
	const settle = async () => {
		const reservation = take();
		if (reservation) await keepReservedEstimate(input.env, reservation);
	};
	return {
		async beforeStep(promptChars: number): Promise<void> {
			await settle();
			const reservation = await reserveAiSpend({
				env: input.env,
				details: input.details,
				source: "chat",
				mailboxId: input.mailboxId,
				jobId: null,
				promptChars,
				maxOutputTokens: CHAT_STEP_MAX_OUTPUT_TOKENS,
				installCapMicros: input.installCapMicros,
				mailboxCapMicros: input.mailboxCapMicros,
			});
			if (!reservation) throw new ChatSpendCapError();
			pending = reservation;
		},
		async afterStep(usage: LanguageModelUsage | undefined): Promise<void> {
			const reservation = take();
			if (reservation) await reconcileAiSpend({ env: input.env, reservation, rates: input.details.rates, usage });
		},
		settle,
	};
}
