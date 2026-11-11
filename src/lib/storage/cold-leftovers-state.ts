import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import {
	DAY_SECONDS,
	DEFAULT_LEFTOVER_SETTINGS,
	isKeptReason,
	parseLeftoverSettingsInput,
	parseLeftoverState,
	type LeftoverKeptReason,
	type LeftoverRunSummary,
	type LeftoverSettings,
	type LeftoverState,
} from "./cold-leftovers-utils";
import { isMissingLeftoverColumn } from "./object-locations";

// The leftover cleanup's settings, its last run and what Admin → Storage shows about leftovers
// (`cold-leftovers.ts` runs the cleanup itself).

type StateEnv = { DB: D1Database };

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** The cleanup's settings and its last run; the defaults (automatic off, 7 days) before migration 0108. */
export async function readLeftoverState(env: StateEnv): Promise<LeftoverState & { available: boolean }> {
	try {
		const row = await env.DB.prepare("SELECT leftover_cleanup FROM storage_state WHERE id = 'default'").first<{
			leftover_cleanup: string | null;
		}>();
		return { ...parseLeftoverState(row?.leftover_cleanup), available: true };
	} catch (error) {
		if (isNoSuchTableError(error) || missingColumnFromError(error) === "leftover_cleanup")
			return { ...DEFAULT_LEFTOVER_SETTINGS, lastRun: null, available: false };
		throw error;
	}
}

async function writeLeftoverState(env: StateEnv, state: LeftoverState): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO storage_state (id, leftover_cleanup, updated_at) VALUES ('default', ?, ?)
		 ON CONFLICT (id) DO UPDATE SET leftover_cleanup = excluded.leftover_cleanup, updated_at = excluded.updated_at`,
	)
		.bind(JSON.stringify(state), seconds(new Date()))
		.run();
}

/** Records a run's summary without touching the settings, which the admin may have changed meanwhile. */
export async function writeLastRun(env: StateEnv, summary: LeftoverRunSummary): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO storage_state (id, leftover_cleanup, updated_at) VALUES ('default', '{}', ?) ON CONFLICT (id) DO NOTHING",
		).bind(seconds(new Date())),
		env.DB.prepare(
			`UPDATE storage_state SET leftover_cleanup = json_set(coalesce(leftover_cleanup, '{}'), '$.lastRun', json(?))
			 WHERE id = 'default'`,
		).bind(JSON.stringify(summary)),
	]);
}

export type SaveSettingsResult =
	{ ok: true; settings: LeftoverSettings } | { ok: false; status: number; error: string; code?: string };

/** Saves `{ automatic, graceDays }` (Admin → Storage), keeping the last run; audited. */
export async function saveLeftoverSettings(env: StateEnv, actorId: string, raw: unknown): Promise<SaveSettingsResult> {
	const parsed = parseLeftoverSettingsInput(raw);
	if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
	const current = await readLeftoverState(env);
	if (!current.available)
		return { ok: false, status: 409, error: "Apply the pending database update first", code: "MIGRATION_PENDING" };
	await writeLeftoverState(env, { ...parsed.value, lastRun: current.lastRun });
	await createAuditLog(env, {
		actorUserId: actorId,
		action: "storage.leftover_cleanup_updated",
		metadata: { ...parsed.value },
	});
	return { ok: true, settings: parsed.value };
}

/** Leftovers still tracked, for one store or all. */
export async function countTracked(env: StateEnv, storeId: string | null): Promise<number> {
	try {
		const row = await env.DB.prepare("SELECT count(*) AS n FROM storage_cold_orphans WHERE (? IS NULL OR store_id = ?)")
			.bind(storeId, storeId)
			.first<{ n: number }>();
		return row?.n ?? 0;
	} catch (error) {
		if (isNoSuchTableError(error)) return 0;
		throw error;
	}
}

export type LeftoverOverview = {
	available: boolean;
	settings: LeftoverSettings;
	lastRun: LeftoverRunSummary | null;
	total: number;
	/** Past the grace period, so the next run looks at them. */
	due: number;
	/** Why the last run kept the leftovers it looked at. */
	kept: Partial<Record<LeftoverKeptReason, number>>;
	byStore: Record<string, number>;
};

/** What Admin → Storage shows about leftovers. */
export async function leftoverOverview(env: StateEnv, now = new Date()): Promise<LeftoverOverview> {
	const state = await readLeftoverState(env);
	const overview: LeftoverOverview = {
		available: state.available,
		settings: { automatic: state.automatic, graceDays: state.graceDays },
		lastRun: state.lastRun,
		total: 0,
		due: 0,
		kept: {},
		byStore: {},
	};
	try {
		const until = seconds(now) - state.graceDays * DAY_SECONDS;
		const { results } = await env.DB.prepare(
			`SELECT store_id, count(*) AS n, sum(first_orphaned_at <= ?) AS due FROM storage_cold_orphans GROUP BY store_id`,
		)
			.bind(until)
			.all<{ store_id: string; n: number; due: number }>();
		for (const row of results ?? []) {
			overview.byStore[row.store_id] = row.n;
			overview.total += row.n;
			overview.due += row.due ?? 0;
		}
		if (state.available) {
			const kept = await env.DB.prepare(
				"SELECT kept_reason, count(*) AS n FROM storage_cold_orphans WHERE kept_reason IS NOT NULL GROUP BY kept_reason",
			).all<{ kept_reason: string; n: number }>();
			for (const row of kept.results ?? []) if (isKeptReason(row.kept_reason)) overview.kept[row.kept_reason] = row.n;
		}
	} catch (error) {
		if (!isNoSuchTableError(error) && !isMissingLeftoverColumn(error)) throw error;
	}
	return overview;
}

/** Why a store cannot be deleted yet when leftover copies are all that is left on it (`deleteStore` checks this
 * last), with the count the store row's "Delete leftovers" offer shows; null when none are tracked there. */
export async function leftoversBlockingDelete(
	env: StateEnv,
	storeId: string,
): Promise<{ error: string; code: "LEFTOVERS_ONLY"; leftoverCount: number } | null> {
	const count = await countTracked(env, storeId);
	if (!count) return null;
	const one = count === 1;
	return {
		error: `${count} leftover ${one ? "copy" : "copies"} of cold storage moves ${one ? "is" : "are"} still on this store; delete the leftovers first`,
		code: "LEFTOVERS_ONLY",
		leftoverCount: count,
	};
}
