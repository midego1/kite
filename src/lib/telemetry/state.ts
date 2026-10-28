import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { createLogger } from "@/lib/logger.mjs";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import {
	isInstallId,
	setupTelemetryDecision,
	telemetryForcedOff,
	telemetryNoticeDue,
	telemetryStartDay,
	telemetryStartDayOutcome,
	telemetryUrl,
	utcDay,
	type TelemetryChoice,
} from "./telemetry-utils";
import type { TelemetryDecision, TelemetryStatus } from "./types";

const logger = createLogger("telemetry");
const ROW_ID = "default";

type StoredState = TelemetryChoice & {
	/** False until migration 0071 is applied. */
	available: boolean;
	/** False until migration 0075 is applied: the notice cannot be stored, so it is never shown. */
	noticeAvailable: boolean;
	enabled: boolean;
	installId: string | null;
	lastSentDay: string | null;
};

type Row = {
	enabled: number;
	install_id: string | null;
	last_sent_day: string | null;
	decision?: string | null;
	start_day?: string | null;
	notice_dismissed?: number;
};

const COLUMNS = "enabled, install_id, last_sent_day";
const UNAVAILABLE: StoredState = {
	available: false,
	noticeAvailable: false,
	enabled: false,
	decision: null,
	installId: null,
	lastSentDay: null,
	startDay: null,
	noticeDismissed: false,
};

/** Thrown by the writes below while migration 0071 (or, for the notice, 0075) has not been applied. */
export class TelemetryUnavailableError extends Error {
	constructor() {
		super("Kite's database needs an update first. Apply the pending updates from the admin overview, then try again.");
		this.name = "TelemetryUnavailableError";
	}
}

const seconds = (now: Date) => Math.floor(now.getTime() / 1000);

async function readRow(env: Pick<CloudflareEnv, "DB">): Promise<{ row: Row | null; noticeAvailable: boolean }> {
	const select = (columns: string) =>
		env.DB.prepare(`SELECT ${columns} FROM telemetry_state WHERE id = ?`).bind(ROW_ID).first<Row>();
	try {
		return { row: await select(`${COLUMNS}, decision, start_day, notice_dismissed`), noticeAvailable: true };
	} catch (error) {
		if (!missingColumnFromError(error)) throw error;
	}
	// Before migration 0075 only the owner's switch wrote a row, so a row is an explicit choice.
	const row = await select(COLUMNS);
	return { row: row && { ...row, decision: row.enabled ? "on" : "off" }, noticeAvailable: false };
}

/** The stored choice. Without the table (migration pending) statistics are simply off. */
export async function readTelemetryState(env: Pick<CloudflareEnv, "DB">): Promise<StoredState> {
	try {
		const { row, noticeAvailable } = await readRow(env);
		const decision = row?.decision === "on" || row?.decision === "off" ? row.decision : null;
		return {
			available: true,
			noticeAvailable,
			enabled: Boolean(row?.enabled),
			decision,
			installId: isInstallId(row?.install_id) ? row.install_id : null,
			lastSentDay: row?.last_sent_day ?? null,
			startDay: row?.start_day ?? null,
			noticeDismissed: Boolean(row?.notice_dismissed),
		};
	} catch (error) {
		if (isNoSuchTableError(error)) return UNAVAILABLE;
		throw error;
	}
}

/**
 * An undecided install whose start day has come is turned on, with a fresh install id: the owner was told on the
 * notice and did not turn statistics off. If the day came while nothing could be sent (`KITE_TELEMETRY=0`, no usable
 * `KITE_TELEMETRY_URL`), the date and the dismissal are cleared instead and nothing turns on, so a later notice names
 * a new date (`telemetryStartDayOutcome`). Runs before every heartbeat and status read; answers what it did.
 */
export async function applyTelemetryStartDay(
	env: Pick<CloudflareEnv, "DB" | "KITE_TELEMETRY" | "KITE_TELEMETRY_URL">,
	now: Date,
): Promise<"started" | "expired" | null> {
	const today = utcDay(now);
	const state = await readTelemetryState(env);
	if (!state.noticeAvailable) return null;
	const outcome = telemetryStartDayOutcome(state, today, {
		forcedOff: telemetryForcedOff(env.KITE_TELEMETRY),
		endpoint: telemetryUrl(env.KITE_TELEMETRY_URL),
	});
	if (outcome === "wait") return null;
	const guard = "WHERE id = ? AND decision IS NULL AND start_day IS NOT NULL AND start_day <= ?";
	const statement =
		outcome === "start"
			? env.DB.prepare(
					`UPDATE telemetry_state SET decision = 'on', enabled = 1, install_id = ?, updated_at = ? ${guard}`,
				).bind(crypto.randomUUID(), seconds(now), ROW_ID, today)
			: env.DB.prepare(
					`UPDATE telemetry_state SET start_day = NULL, notice_dismissed = 0, updated_at = ? ${guard}`,
				).bind(seconds(now), ROW_ID, today);
	const result = await statement.run();
	if ((result.meta?.changes ?? 0) !== 1) return null;
	logger.info(outcome === "start" ? "telemetry.start_day_reached" : "telemetry.start_day_expired", {});
	return outcome === "start" ? "started" : "expired";
}

export async function getTelemetryStatus(
	env: Pick<CloudflareEnv, "DB" | "KITE_TELEMETRY" | "KITE_TELEMETRY_URL">,
	now: Date = new Date(),
): Promise<TelemetryStatus> {
	await applyTelemetryStartDay(env, now);
	const stored = await readTelemetryState(env);
	const forcedOff = telemetryForcedOff(env.KITE_TELEMETRY);
	const endpoint = telemetryUrl(env.KITE_TELEMETRY_URL);
	return {
		enabled: stored.enabled,
		decision: stored.decision,
		startDay: stored.decision === null && !forcedOff ? stored.startDay : null,
		notice: telemetryNoticeDue(stored, { noticeAvailable: stored.noticeAvailable, forcedOff, endpoint }),
		forcedOff,
		available: stored.available,
		installId: stored.installId,
		lastSentDay: stored.lastSentDay,
		endpoint,
	};
}

/**
 * The owner's explicit choice, from Admin → General or the notice's buttons. Turning statistics on makes a fresh
 * random install id; turning them off deletes it, so turning them on again cannot be linked to earlier reports, and
 * records `off`, which nothing turns on again. Returns the state before the change, so an opt-out can ask the
 * collector to erase the old id's reports (`eraseAfterOptOut`).
 */
export async function setTelemetryEnabled(env: Pick<CloudflareEnv, "DB">, enabled: boolean): Promise<StoredState> {
	const current = await readTelemetryState(env);
	if (!current.available) throw new TelemetryUnavailableError();
	const values = [
		ROW_ID,
		enabled ? 1 : 0,
		enabled ? (current.installId ?? crypto.randomUUID()) : null,
		enabled ? current.lastSentDay : null,
		seconds(new Date()),
	];
	const statement = current.noticeAvailable
		? env.DB.prepare(
				"INSERT INTO telemetry_state (id, enabled, install_id, last_sent_day, updated_at, decision) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, install_id = excluded.install_id, last_sent_day = excluded.last_sent_day, updated_at = excluded.updated_at, decision = excluded.decision",
			).bind(...values, enabled ? "on" : "off")
		: env.DB.prepare(
				"INSERT INTO telemetry_state (id, enabled, install_id, last_sent_day, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, install_id = excluded.install_id, last_sent_day = excluded.last_sent_day, updated_at = excluded.updated_at",
			).bind(...values);
	try {
		await statement.run();
	} catch (error) {
		if (isNoSuchTableError(error)) throw new TelemetryUnavailableError();
		throw error;
	}
	return current;
}

/**
 * The one-time notice of an undecided install. `shown` fixes the start day the first time the owner sees it (never
 * moving it later), `dismissed` closes the notice for good without choosing. A no-op once decided or when the
 * notice is not due (`telemetryNoticeDue`: `KITE_TELEMETRY=0`, nothing would be sent, or already dismissed).
 */
export async function markTelemetryNotice(
	env: Pick<CloudflareEnv, "DB" | "KITE_TELEMETRY" | "KITE_TELEMETRY_URL">,
	action: "shown" | "dismissed",
	now: Date = new Date(),
): Promise<void> {
	const state = await readTelemetryState(env);
	if (!state.noticeAvailable) throw new TelemetryUnavailableError();
	const context = {
		noticeAvailable: true,
		forcedOff: telemetryForcedOff(env.KITE_TELEMETRY),
		endpoint: telemetryUrl(env.KITE_TELEMETRY_URL),
	};
	if (!telemetryNoticeDue(state, context)) return;
	await env.DB.prepare(
		"INSERT INTO telemetry_state (id, enabled, start_day, notice_dismissed, updated_at) VALUES (?, 0, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET start_day = coalesce(telemetry_state.start_day, excluded.start_day), notice_dismissed = max(telemetry_state.notice_dismissed, excluded.notice_dismissed), updated_at = excluded.updated_at WHERE telemetry_state.decision IS NULL",
	)
		.bind(ROW_ID, telemetryStartDay(now), action === "dismissed" ? 1 : 0, seconds(now))
		.run();
}

/**
 * Finishing the first-run setup with the "Usage statistics" switch: records `on` (with a fresh install id) or
 * `off`. Nothing is recorded, and the install stays undecided, under `KITE_TELEMETRY=0` or when the request did not
 * carry the switch (`setupTelemetryDecision`). Never overwrites an existing row. Returns what it recorded.
 */
export async function recordSetupTelemetryChoice(
	env: Pick<CloudflareEnv, "DB" | "KITE_TELEMETRY">,
	requested: unknown,
	now: Date = new Date(),
): Promise<TelemetryDecision | null> {
	const decision = setupTelemetryDecision(requested, telemetryForcedOff(env.KITE_TELEMETRY));
	if (!decision) return null;
	const on = decision === "on";
	const result = await env.DB.prepare(
		"INSERT INTO telemetry_state (id, enabled, install_id, decision, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
	)
		.bind(ROW_ID, on ? 1 : 0, on ? crypto.randomUUID() : null, decision, seconds(now))
		.run();
	return (result.meta?.changes ?? 0) === 1 ? decision : null;
}

/**
 * Claims today's heartbeat: true for exactly one caller per UTC day, and only while statistics are on. Claiming
 * before sending means a failed heartbeat is not retried until the next day.
 */
export async function claimTelemetryDay(env: Pick<CloudflareEnv, "DB">, day: string): Promise<boolean> {
	const result = await env.DB.prepare(
		"UPDATE telemetry_state SET last_sent_day = ? WHERE id = ? AND enabled = 1 AND (last_sent_day IS NULL OR last_sent_day <> ?)",
	)
		.bind(day, ROW_ID, day)
		.run();
	return (result.meta?.changes ?? 0) === 1;
}
