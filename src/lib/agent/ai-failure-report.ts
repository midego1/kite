import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiUsage } from "@/db/schema";
import { createLogger } from "@/lib/logger.mjs";
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
import { activeAgentProviderChangedAt } from "./provider-connections";

const logger = createLogger("agent");

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

/** Ask AI when the provider settings could not be read: the groups still show, the assistant is not offered. */
const SETTINGS_UNREADABLE: AiFailureReport["assistant"] = {
	available: false,
	reason:
		"Ask AI can't run: Kite could not read the AI provider settings. Reload the page, or check them in Admin → Agent.",
	link: { href: "/agent#ai-provider", label: "Open AI provider settings" },
};

/** Whether Ask AI can run, or SETTINGS_UNREADABLE when the provider or install settings can't be read. */
async function askAiStateFor(env: CloudflareEnv, rows: AiFailureRow[]): Promise<AiFailureReport["assistant"]> {
	let config: Awaited<ReturnType<typeof getAgentProviderPublicConfig>>;
	let install: Awaited<ReturnType<typeof getAutoReadInstallSettings>>;
	let changedAt: Date | null;
	try {
		[config, install, changedAt] = await Promise.all([
			getAgentProviderPublicConfig(env),
			getAutoReadInstallSettings(env),
			activeAgentProviderChangedAt(env),
		]);
	} catch (error) {
		logger.warn("ai.failure_report_settings_unreadable", { error: error instanceof Error ? error.name : "unknown" });
		return SETTINGS_UNREADABLE;
	}
	// Failures record the preset id (`openai`, `custom`) rather than the saved provider, so two saved providers with
	// the same preset look alike here; `changedAt` keeps a switch between them from inheriting the other's failures.
	const provider = config.provider === "cloudflare" ? "cloudflare" : config.preset;
	const blocking = blockingAiFailure(rows, {
		provider,
		model: config.model,
		changedAt: changedAt?.toISOString() ?? null,
	});
	return askAiState({
		enabled: install.agentEnabled,
		configured: config.configured,
		keyUnreadable: !!config.keyUnreadable,
		externalNotAllowed: config.provider === "compatible" && !install.externalAutoReadAllowed,
		blocking: blocking && !(await workedSince(env, blocking)) ? blocking : null,
		providerLabel: aiProviderLabel(provider) ?? "The AI provider",
	});
}

/**
 * The last day's failed AI requests grouped and explained without a model call, the text Ask AI would send and
 * whether the assistant can run at all. Reads only codes, providers, models and times.
 */
export async function loadAiFailureReport(env: CloudflareEnv, now = Date.now()): Promise<AiFailureReport> {
	const since = new Date(now - REPORT_WINDOW_MS);
	const rows = await listAiFailuresSince(env, since);
	const groups = groupAiFailures(rows);
	const capped = rows.length >= AI_ERRORS_KEPT;
	return {
		since: since.toISOString(),
		total: rows.length,
		capped,
		groups,
		prompt: aiFailurePrompt(groups, rows.length, capped),
		assistant: await askAiStateFor(env, rows),
	};
}
