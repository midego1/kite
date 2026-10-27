import type { ModuleId } from "@/lib/modules/module-types";

export type TelemetryRuntime = "workers" | "node";

export type HeartbeatCounts = {
	users_total: number;
	users_active_1d: number;
	users_active_7d: number;
	users_active_30d: number;
	mailboxes_total: number;
	mailboxes_active_1d: number;
	inbound_1d: number;
	outbound_1d: number;
};

/** Heartbeat body, `telemetry_schema_version` 1. The collector rejects any other key. */
export type HeartbeatPayload = {
	telemetry_schema_version: 1;
	install_id: string;
	version: string;
	runtime: TelemetryRuntime;
	modules_enabled: ModuleId[];
} & HeartbeatCounts;

/** What Admin → General shows. `installId` is shown to the owner only, so they can ask for its data to be removed. */
export type TelemetryStatus = {
	enabled: boolean;
	/** `KITE_TELEMETRY` turns it off; the switch is then disabled. */
	forcedOff: boolean;
	/** False until migration 0070 is applied. */
	available: boolean;
	installId: string | null;
	/** UTC day of the last heartbeat attempt, whether or not the collector got it. */
	lastSentDay: string | null;
	/** Collector URL, or null when `KITE_TELEMETRY_URL` is unusable (nothing is sent). */
	endpoint: string | null;
};
