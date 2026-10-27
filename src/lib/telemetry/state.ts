import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { telemetryState } from "@/db/schema/telemetry";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { isInstallId, telemetryForcedOff, telemetryUrl } from "./telemetry-utils";
import type { TelemetryStatus } from "./types";

const ROW_ID = "default";

type StoredState = { available: boolean; enabled: boolean; installId: string | null; lastSentDay: string | null };

/** Thrown by `setTelemetryEnabled` while migration 0070 has not been applied. */
export class TelemetryUnavailableError extends Error {
	constructor() {
		super("Kite's database needs an update first. Apply the pending updates from the admin overview, then try again.");
		this.name = "TelemetryUnavailableError";
	}
}

/** The stored choice. Without the table (migration pending) statistics are simply off. */
export async function readTelemetryState(env: Pick<CloudflareEnv, "DB">): Promise<StoredState> {
	try {
		const [row] = await getDb(env).select().from(telemetryState).where(eq(telemetryState.id, ROW_ID)).limit(1);
		return {
			available: true,
			enabled: Boolean(row?.enabled),
			installId: isInstallId(row?.installId) ? row.installId : null,
			lastSentDay: row?.lastSentDay ?? null,
		};
	} catch (error) {
		if (isNoSuchTableError(error)) return { available: false, enabled: false, installId: null, lastSentDay: null };
		throw error;
	}
}

export async function getTelemetryStatus(
	env: Pick<CloudflareEnv, "DB" | "KITE_TELEMETRY" | "KITE_TELEMETRY_URL">,
): Promise<TelemetryStatus> {
	const stored = await readTelemetryState(env);
	return {
		enabled: stored.enabled,
		forcedOff: telemetryForcedOff(env.KITE_TELEMETRY),
		available: stored.available,
		installId: stored.installId,
		lastSentDay: stored.lastSentDay,
		endpoint: telemetryUrl(env.KITE_TELEMETRY_URL),
	};
}

/**
 * Turning statistics on makes a fresh random install id; turning them off deletes it, so a later opt-in cannot be
 * linked to earlier reports.
 */
export async function setTelemetryEnabled(env: Pick<CloudflareEnv, "DB">, enabled: boolean): Promise<void> {
	const current = await readTelemetryState(env);
	if (!current.available) throw new TelemetryUnavailableError();
	const values = {
		enabled,
		installId: enabled ? (current.installId ?? crypto.randomUUID()) : null,
		lastSentDay: enabled ? current.lastSentDay : null,
		updatedAt: new Date(),
	};
	try {
		await getDb(env)
			.insert(telemetryState)
			.values({ id: ROW_ID, ...values })
			.onConflictDoUpdate({ target: telemetryState.id, set: values });
	} catch (error) {
		if (isNoSuchTableError(error)) throw new TelemetryUnavailableError();
		throw error;
	}
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
