import type { LanguageModelUsage } from "ai";
import { newId } from "@/lib/ids";
import type { ReconcileAiSpendInput, ReserveAiSpendInput, SpendReservation } from "./spend-types";
import { UNKNOWN_RATES_INPUT_TOKEN_CAP, actualSpend, estimateSpend, utcDayStartSeconds } from "./spend-utils";

const INSERT_RESERVATION = `INSERT INTO ai_usage (id, created_at, provider, model, source, input_tokens, output_tokens, cost_usd_micros, mailbox_id, job_id, reserved)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1`;

// The cap check and the insert are one statement, so concurrent reservations
// cannot both read the same total and overspend.
const COST_CAP_CONDITION = `
WHERE (SELECT coalesce(sum(cost_usd_micros), 0) FROM ai_usage WHERE created_at >= ?) + ? <= ?
AND (? IS NULL OR (SELECT coalesce(sum(cost_usd_micros), 0) FROM ai_usage WHERE mailbox_id = ? AND created_at >= ?) + ? <= ?)`;

const TOKEN_CAP_CONDITION = `
WHERE (SELECT coalesce(sum(input_tokens), 0) FROM ai_usage WHERE created_at >= ?) + ? <= ?`;

/**
 * Reserves the estimated cost of one automatic model call against the install
 * and mailbox daily caps. Returns null when the call would exceed a cap.
 */
export async function reserveAiSpend(input: ReserveAiSpendInput): Promise<SpendReservation | null> {
	const now = input.now ?? new Date();
	const dayStart = utcDayStartSeconds(now);
	const estimate = estimateSpend(input.promptChars, input.maxOutputTokens, input.details.rates);
	const id = newId("usage");
	const values = [
		id,
		Math.floor(now.getTime() / 1000),
		input.details.provider,
		input.details.modelId,
		input.source,
		estimate.inputTokens,
		estimate.outputTokens,
		estimate.costUsdMicros,
		input.mailboxId,
		input.jobId,
	];
	const statement =
		estimate.costUsdMicros === null
			? input.env.DB.prepare(INSERT_RESERVATION + TOKEN_CAP_CONDITION).bind(
					...values,
					dayStart,
					estimate.inputTokens,
					UNKNOWN_RATES_INPUT_TOKEN_CAP,
				)
			: input.env.DB.prepare(INSERT_RESERVATION + COST_CAP_CONDITION).bind(
					...values,
					dayStart,
					estimate.costUsdMicros,
					input.installCapMicros,
					input.mailboxCapMicros,
					input.mailboxId,
					dayStart,
					estimate.costUsdMicros,
					input.mailboxCapMicros,
				);
	const result = await statement.run();
	return result.meta.changes > 0 ? { id, ...estimate } : null;
}

/**
 * Reserves the call's estimated cost, runs it and reconciles the reservation with the usage it
 * reported (none when it threw). Returns null without calling when a cap would be exceeded.
 */
export async function withReservedSpend<T extends { usage: LanguageModelUsage | undefined }>(
	input: ReserveAiSpendInput,
	call: () => Promise<T>,
): Promise<T | null> {
	const reservation = await reserveAiSpend(input);
	if (!reservation) return null;
	let usage: LanguageModelUsage | undefined;
	try {
		const result = await call();
		usage = result.usage;
		return result;
	} finally {
		await reconcileAiSpend({ env: input.env, reservation, rates: input.details.rates, usage });
	}
}

/** Replaces a reservation's estimate with the call's actual usage and releases it. */
export async function reconcileAiSpend({ env, reservation, rates, usage }: ReconcileAiSpendInput): Promise<void> {
	const actual = actualSpend(reservation.mode, usage, rates);
	await env.DB.prepare(
		"UPDATE ai_usage SET input_tokens = ?, output_tokens = ?, cost_usd_micros = ?, reserved = 0 WHERE id = ?",
	)
		.bind(actual.inputTokens, actual.outputTokens, actual.costUsdMicros, reservation.id)
		.run();
}
