import type { LanguageModelUsage } from "ai";
import { getAutoReadInstallSettings } from "@/lib/agent/auto-read/install-settings";
import { keepReservedEstimate, reconcileAiSpend, reserveAiSpend } from "@/lib/agent/auto-read/spend";
import type { AutoSpendSource, SpendReservation } from "@/lib/agent/auto-read/spend-types";
import { utcDayStartSeconds } from "@/lib/agent/auto-read/spend-utils";
import { resolveAgentModelRates } from "@/lib/agent/model-prices-utils";
import type { AgentModelRates } from "@/lib/agent/provider-types";
import { EMBEDDING_MODEL_ID, type EmbeddingProvider } from "./embedding";

/** Kite's built-in price list already carries bge-m3 (`model-prices.json`); there is no per-install override. */
function embeddingRates(): AgentModelRates | undefined {
	return resolveAgentModelRates({}, [EMBEDDING_MODEL_ID])[EMBEDDING_MODEL_ID];
}

function providerName(kind: EmbeddingProvider["kind"]): string {
	return kind === "workers_ai" ? "cloudflare" : "compatible";
}

/**
 * Reserves the estimated cost of one embedding batch against the install cap only (no mailbox: a batch can cover
 * messages from several mailboxes). `source` is `embedding_backfill` for a batch of rows the backfill queued
 * (`indexer.ts`'s `isBackfillClaim`), so `backfillCapReached` can tell its own spend apart from live indexing's;
 * both still draw from the one install cap. Null means a cap would be exceeded; the drain releases its claim and
 * stops for this run (or, for a backfill batch already past its own share, is simply not retried as that source).
 */
export async function reserveEmbeddingBatchSpend(
	env: CloudflareEnv,
	providerKind: EmbeddingProvider["kind"],
	promptChars: number,
	source: Extract<AutoSpendSource, "embedding" | "embedding_backfill"> = "embedding",
): Promise<SpendReservation | null> {
	const install = await getAutoReadInstallSettings(env);
	return reserveAiSpend({
		env,
		source,
		mailboxId: null,
		jobId: null,
		details: { modelId: EMBEDDING_MODEL_ID, provider: providerName(providerKind), rates: embeddingRates() },
		promptChars,
		maxOutputTokens: 0,
		installCapMicros: install.dailySpendCapMicros,
		mailboxCapMicros: null,
		tokenCap: install.autoReadTokenCap,
	});
}

/**
 * Reserves one search query's embedding (source `embedding_query`), tied to the mailbox the search ran in when
 * there is a single one selected, else null (install cap only — a query over several mailboxes has no one mailbox
 * to charge).
 */
export async function reserveEmbeddingQuerySpend(
	env: CloudflareEnv,
	providerKind: EmbeddingProvider["kind"],
	mailboxId: string | null,
	queryChars: number,
): Promise<SpendReservation | null> {
	const install = await getAutoReadInstallSettings(env);
	return reserveAiSpend({
		env,
		source: "embedding_query",
		mailboxId,
		jobId: null,
		details: { modelId: EMBEDDING_MODEL_ID, provider: providerName(providerKind), rates: embeddingRates() },
		promptChars: queryChars,
		maxOutputTokens: 0,
		installCapMicros: install.dailySpendCapMicros,
		mailboxCapMicros: null,
		tokenCap: install.autoReadTokenCap,
	});
}

/** Settles a reservation with the embedding call's actual input tokens, or keeps its estimate when it failed. */
export async function settleEmbeddingSpend(
	env: CloudflareEnv,
	reservation: SpendReservation,
	result: { inputTokens: number } | { failed: string },
): Promise<void> {
	if ("failed" in result) {
		await keepReservedEstimate(env, reservation, { status: "failed", errorCode: result.failed });
		return;
	}
	const usage = {
		inputTokens: result.inputTokens,
		outputTokens: 0,
		totalTokens: result.inputTokens,
	} as LanguageModelUsage;
	await reconcileAiSpend({ env, reservation, rates: embeddingRates(), usage, outcome: { status: "ok" } });
}

/**
 * Today's share of the install's daily spend cap the backfill itself has used (source `embedding_backfill` only,
 * never live indexing's `embedding`), so both the insert side (`backfill.ts`) and the drain side (`indexer.ts`)
 * can give way to everything else without live, just-delivered mail ever being held back by the backfill's cap.
 */
export async function backfillCapReached(env: CloudflareEnv, capSharePercent: number): Promise<boolean> {
	const install = await getAutoReadInstallSettings(env);
	const row = await env.DB.prepare(
		"SELECT coalesce(sum(cost_usd_micros), 0) AS spent FROM ai_usage WHERE created_at >= ? AND source = 'embedding_backfill'",
	)
		.bind(utcDayStartSeconds(new Date()))
		.first<{ spent: number }>();
	const cap = Math.floor((install.dailySpendCapMicros * capSharePercent) / 100);
	return Number(row?.spent ?? 0) >= cap;
}
