import type { ModuleId } from "@/lib/modules/module-types";

export type TelemetryRuntime = "workers" | "node";

/** Exact counts, read on the install. They never leave it: the heartbeat carries their ranges. */
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

export type AccountBucket = "0" | "1" | "2-5" | "6-20" | "21-100" | "100+";
export type MessageBucket = "0" | "1-10" | "11-100" | "101-1000" | "1000+";

export type HeartbeatBuckets = {
	users_total: AccountBucket;
	users_active_1d: AccountBucket;
	users_active_7d: AccountBucket;
	users_active_30d: AccountBucket;
	mailboxes_total: AccountBucket;
	mailboxes_active_1d: AccountBucket;
	inbound_1d: MessageBucket;
	outbound_1d: MessageBucket;
};

/** Heartbeat body, `telemetry_schema_version` 2. The collector rejects any other key or value. */
export type HeartbeatPayload = {
	telemetry_schema_version: 2;
	install_id: string;
	version: string;
	runtime: TelemetryRuntime;
	modules_enabled: ModuleId[];
} & HeartbeatBuckets;

/** What Admin → General shows. `installId` is shown to the owner only, so they can ask for its data to be removed. */
export type TelemetryStatus = {
	enabled: boolean;
	/** `KITE_TELEMETRY` keeps it off; the switch can then only be turned off. */
	forcedOff: boolean;
	/** False until migration 0071 is applied. */
	available: boolean;
	installId: string | null;
	/** UTC day of the last heartbeat attempt, whether or not the collector got it. */
	lastSentDay: string | null;
	/** Collector URL, or null when `KITE_TELEMETRY_URL` is empty or unusable (nothing is sent). */
	endpoint: string | null;
};

/**
 * What became of the collector's copy when the owner turned statistics off: `erased` (the collector confirmed),
 * `failed` (no confirmation; the id is returned once so the owner can ask by email) or `not_needed` (nothing was
 * ever sent).
 */
export type TelemetryErasure = { outcome: "erased" | "failed" | "not_needed"; installId: string | null };

/** `PUT /api/admin/telemetry` answers the new status, plus the erasure when statistics were turned off. */
export type TelemetrySaveResult = TelemetryStatus & { erasure?: TelemetryErasure };
