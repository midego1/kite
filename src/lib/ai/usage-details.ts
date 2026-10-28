import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import type { AiUsageOutcome } from "./usage-types";

/** The columns migration 0078 adds to `ai_usage`. */
const AI_USAGE_DETAIL_COLUMNS = [
	"status",
	"error_code",
	"duration_ms",
	"finish_reason",
	"input_rate",
	"output_rate",
] as const;

const DETAIL_ASSIGNMENTS = AI_USAGE_DETAIL_COLUMNS.map((column) => `${column} = ?`).join(", ");

function isMissingUsageDetailColumn(error: unknown): boolean {
	const column = missingColumnFromError(error);
	return !!column && (AI_USAGE_DETAIL_COLUMNS as readonly string[]).includes(column);
}

function detailValues(outcome: AiUsageOutcome) {
	return [
		outcome.status,
		outcome.errorCode ?? null,
		outcome.durationMs === undefined || outcome.durationMs === null
			? null
			: Math.max(0, Math.round(outcome.durationMs)),
		outcome.finishReason ?? null,
		outcome.rates?.input ?? null,
		outcome.rates?.output ?? null,
	];
}

/**
 * Runs `UPDATE ai_usage SET <assignments>, <details> WHERE id = ?`. A deploy runs before its migrations are applied,
 * so without migration 0078 the same update runs again without the details: spend must settle either way.
 */
export async function updateAiUsage(
	env: CloudflareEnv,
	id: string,
	assignments: string,
	values: unknown[],
	outcome: AiUsageOutcome,
): Promise<void> {
	const set = assignments ? `${assignments}, ` : "";
	try {
		await env.DB.prepare(`UPDATE ai_usage SET ${set}${DETAIL_ASSIGNMENTS} WHERE id = ?`)
			.bind(...values, ...detailValues(outcome), id)
			.run();
	} catch (error) {
		if (!isMissingUsageDetailColumn(error)) throw error;
		if (assignments)
			await env.DB.prepare(`UPDATE ai_usage SET ${assignments} WHERE id = ?`)
				.bind(...values, id)
				.run();
	}
}

const detailsReady = new WeakSet<object>();

/**
 * Whether `ai_usage` has the detail columns (migration 0078). A positive answer is kept for the database binding; a
 * negative one is asked again, since an admin can apply the update at any time.
 */
export async function aiUsageDetailsReady(env: CloudflareEnv): Promise<boolean> {
	if (detailsReady.has(env.DB)) return true;
	try {
		await env.DB.prepare(`SELECT ${AI_USAGE_DETAIL_COLUMNS.join(", ")} FROM ai_usage LIMIT 0`).all();
		detailsReady.add(env.DB);
		return true;
	} catch (error) {
		if (isMissingUsageDetailColumn(error)) return false;
		throw error;
	}
}
