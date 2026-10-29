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
	"cost_estimated",
] as const;

const DETAIL_ASSIGNMENTS = AI_USAGE_DETAIL_COLUMNS.map((column) => `${column} = ?`).join(", ");

/** How long a "not migrated yet" answer is trusted before asking again, so an admin's update is noticed. */
const NOT_READY_RECHECK_MS = 60_000;

function isMissingUsageDetailColumn(error: unknown): boolean {
	const column = missingColumnFromError(error);
	return !!column && (AI_USAGE_DETAIL_COLUMNS as readonly string[]).includes(column);
}

/**
 * The outcome as stored. An answer that hit the output limit (finish reason `length`) is recorded as failed with
 * `cut_off` in every feature, since every feature discards or flags such an answer; its usage still counts.
 */
function settledOutcome(outcome: AiUsageOutcome): AiUsageOutcome {
	return outcome.status === "ok" && outcome.finishReason === "length"
		? { ...outcome, status: "failed", errorCode: "cut_off" }
		: outcome;
}

function detailValues(outcome: AiUsageOutcome) {
	const stored = settledOutcome(outcome);
	return [
		stored.status,
		stored.errorCode ?? null,
		stored.durationMs === undefined || stored.durationMs === null ? null : Math.max(0, Math.round(stored.durationMs)),
		stored.finishReason ?? null,
		stored.rates?.input ?? null,
		stored.rates?.output ?? null,
		stored.costEstimated ? 1 : 0,
	];
}

/**
 * Runs `UPDATE ai_usage SET <assignments>, <details> WHERE id = ?`. A deploy runs before its migrations are applied,
 * so without migration 0078 only the assignments run: spend must settle either way.
 */
export async function updateAiUsage(
	env: CloudflareEnv,
	id: string,
	assignments: string,
	values: unknown[],
	outcome: AiUsageOutcome,
): Promise<void> {
	const base = async () => {
		if (assignments)
			await env.DB.prepare(`UPDATE ai_usage SET ${assignments} WHERE id = ?`)
				.bind(...values, id)
				.run();
	};
	if (!(await aiUsageDetailsReady(env))) return base();
	const set = assignments ? `${assignments}, ` : "";
	try {
		await env.DB.prepare(`UPDATE ai_usage SET ${set}${DETAIL_ASSIGNMENTS} WHERE id = ?`)
			.bind(...values, ...detailValues(outcome), id)
			.run();
	} catch (error) {
		// The columns went away (a restore of an older database): forget the answer and settle without them.
		if (!isMissingUsageDetailColumn(error)) throw error;
		readiness.delete(env.DB);
		await base();
	}
}

// Per database binding: true once the columns exist, else when to ask again.
const readiness = new WeakMap<object, true | number>();

/**
 * Whether `ai_usage` has the detail columns (migration 0078). A positive answer is kept for the database binding; a
 * negative one for a minute, so settling before the update costs one extra query a minute rather than one per call.
 */
export async function aiUsageDetailsReady(env: CloudflareEnv, now = Date.now()): Promise<boolean> {
	const known = readiness.get(env.DB);
	if (known === true) return true;
	if (typeof known === "number" && now < known) return false;
	try {
		await env.DB.prepare(`SELECT ${AI_USAGE_DETAIL_COLUMNS.join(", ")} FROM ai_usage LIMIT 0`).all();
		readiness.set(env.DB, true);
		return true;
	} catch (error) {
		if (!isMissingUsageDetailColumn(error)) throw error;
		readiness.set(env.DB, now + NOT_READY_RECHECK_MS);
		return false;
	}
}
