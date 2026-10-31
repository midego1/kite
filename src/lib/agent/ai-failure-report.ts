import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiUsage } from "@/db/schema";
import { AI_ERRORS_KEPT, listAiFailuresSince } from "./ai-errors";
import type { AiFailureReport } from "./ai-failure-report-types";
import {
	aiFailurePrompt,
	aiProviderLabel,
	askAiState,
	blockingAiFailure,
	groupAiFailures,
	type AiFailureRow,
} from "./ai-failure-report-utils";
import { getAutoReadInstallSettings } from "./auto-read/install-settings";
import { getAgentProviderPublicConfig } from "./provider";

/** The same window as the overview's count, so the report explains exactly the failures it counted. */
const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Whether a request to the failure's provider worked after it; unknown (before migration 0078) counts as not. */
async function workedSince(env: CloudflareEnv, failure: AiFailureRow): Promise<boolean> {
	try {
		const [row] = await getDb(env)
			.select({ id: aiUsage.id })
			.from(aiUsage)
			.where(
				and(
					eq(aiUsage.provider, failure.provider ?? ""),
					// `status` comes with migration 0078 and is not in the Drizzle schema; without it the read fails.
					sql`"ai_usage"."status" = 'ok'`,
					gt(aiUsage.createdAt, new Date(failure.at)),
				),
			)
			.limit(1);
		return !!row;
	} catch {
		return false;
	}
}

/**
 * The last day's failed AI requests grouped and explained without a model call, the text Ask AI would send and
 * whether the assistant can run at all. Reads only codes, providers, models and times.
 */
export async function loadAiFailureReport(env: CloudflareEnv, now = Date.now()): Promise<AiFailureReport> {
	const since = new Date(now - REPORT_WINDOW_MS);
	const [rows, config, install] = await Promise.all([
		listAiFailuresSince(env, since),
		getAgentProviderPublicConfig(env),
		getAutoReadInstallSettings(env),
	]);
	const provider = config.provider === "cloudflare" ? "cloudflare" : config.preset;
	const blocking = blockingAiFailure(rows, { provider, model: config.model });
	const groups = groupAiFailures(rows);
	const capped = rows.length >= AI_ERRORS_KEPT;
	return {
		since: since.toISOString(),
		total: rows.length,
		capped,
		groups,
		prompt: aiFailurePrompt(groups, rows.length, capped),
		assistant: askAiState({
			enabled: install.agentEnabled,
			configured: config.configured,
			keyUnreadable: !!config.keyUnreadable,
			externalNotAllowed: config.provider === "compatible" && !install.externalAutoReadAllowed,
			blocking: blocking && !(await workedSince(env, blocking)) ? blocking : null,
			providerLabel: aiProviderLabel(provider) ?? "The AI provider",
		}),
	};
}
