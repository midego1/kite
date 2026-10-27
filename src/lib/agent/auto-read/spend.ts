import type { LanguageModelUsage } from "ai";
import { newId } from "@/lib/ids";
import type { ReconcileAiSpendInput, ReserveAiSpendInput, SpendCapKind, SpendReservation } from "./spend-types";
import {
	INTERACTIVE_SPEND_SOURCES,
	actualSpend,
	estimateSpend,
	tokenAllowanceKind,
	utcDayStartSeconds,
	type TokenAllowanceKind,
} from "./spend-utils";

const INSERT_RESERVATION = `INSERT INTO ai_usage (id, created_at, provider, model, source, input_tokens, output_tokens, cost_usd_micros, mailbox_id, job_id, reserved)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1`;

// The cap check and the insert are one statement, so concurrent reservations
// cannot both read the same total and overspend.
const COST_CAP_CONDITION = `
WHERE (SELECT coalesce(sum(cost_usd_micros), 0) FROM ai_usage WHERE created_at >= ?) + ? <= ?
AND (? IS NULL OR (SELECT coalesce(sum(cost_usd_micros), 0) FROM ai_usage WHERE mailbox_id = ? AND created_at >= ?) + ? <= ?)`;

// Without rates, chat and automatic reading each have their own input-token allowance, so neither starves the other.
const INTERACTIVE_SOURCES_SQL = INTERACTIVE_SPEND_SOURCES.map((source) => `'${source}'`).join(", ");
const SOURCE_FILTER: Record<TokenAllowanceKind, string> = {
	chat: `source IN (${INTERACTIVE_SOURCES_SQL})`,
	auto_read: `source NOT IN (${INTERACTIVE_SOURCES_SQL})`,
};
const tokensUsedSql = (kind: TokenAllowanceKind) =>
	`SELECT coalesce(sum(input_tokens), 0) FROM ai_usage WHERE created_at >= ? AND ${SOURCE_FILTER[kind]}`;
const tokenCapCondition = (kind: TokenAllowanceKind) => `
WHERE (${tokensUsedSql(kind)}) + ? <= ?`;

/**
 * Reserves the estimated cost of one model call against the install and
 * mailbox daily caps. Returns null when the call would exceed a cap.
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
			? input.env.DB.prepare(INSERT_RESERVATION + tokenCapCondition(tokenAllowanceKind(input.source))).bind(
					...values,
					dayStart,
					estimate.inputTokens,
					input.tokenCap,
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

/**
 * Settles a reservation whose call ended without reporting usage (aborted or failed mid-stream): the estimate
 * stays as the recorded spend, so the cap errs on the side of stopping.
 */
export async function keepReservedEstimate(env: CloudflareEnv, reservation: SpendReservation): Promise<void> {
	await env.DB.prepare("UPDATE ai_usage SET reserved = 0 WHERE id = ?").bind(reservation.id).run();
}

/**
 * Which cap a refused reservation ran into: the source's token allowance without model rates, otherwise the
 * mailbox's dollar cap when that alone is passed, else the install's. Only called after a refusal.
 */
export async function refusedSpendCap(input: ReserveAiSpendInput): Promise<SpendCapKind> {
	const estimate = estimateSpend(input.promptChars, input.maxOutputTokens, input.details.rates);
	if (estimate.costUsdMicros === null)
		return tokenAllowanceKind(input.source) === "chat" ? "chat_tokens" : "auto_read_tokens";
	if (input.mailboxCapMicros === null) return "install_dollars";
	const dayStart = utcDayStartSeconds(input.now ?? new Date());
	const row = await input.env.DB.prepare(
		"SELECT coalesce(sum(cost_usd_micros), 0) AS spent FROM ai_usage WHERE mailbox_id = ? AND created_at >= ?",
	)
		.bind(input.mailboxId, dayStart)
		.first<{ spent: number }>();
	return Number(row?.spent ?? 0) + estimate.costUsdMicros > input.mailboxCapMicros
		? "mailbox_dollars"
		: "install_dollars";
}
