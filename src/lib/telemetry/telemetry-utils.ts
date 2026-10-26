import { MODULE_IDS } from "@/lib/modules/client-data/module-ids";
import type { ModuleId } from "@/lib/modules/module-types";
import type { HeartbeatCounts, HeartbeatPayload, TelemetryRuntime } from "./types";

const TELEMETRY_SCHEMA_VERSION = 1;

/**
 * Where heartbeats go unless `KITE_TELEMETRY_URL` says otherwise: the collector in `deploy/telemetry-collector/`,
 * run by the Kite maintainer on Cloudflare.
 */
const DEFAULT_TELEMETRY_URL = "https://kite-telemetry.midego.net/v1/heartbeat";

/** Audit actions of the owner's choice, listed in Admin → Activity. */
export const TELEMETRY_AUDIT_ACTIONS = ["telemetry.enabled", "telemetry.disabled"] as const;

/** A heartbeat that takes longer is abandoned; the next one is due the next day. */
export const TELEMETRY_TIMEOUT_MS = 5_000;

/** Upper bound of every count, so a corrupt value can never become something other than a small integer. */
const MAX_COUNT = 2_147_483_647;

const COUNT_FIELDS = [
	"users_total",
	"users_active_1d",
	"users_active_7d",
	"users_active_30d",
	"mailboxes_total",
	"mailboxes_active_1d",
	"inbound_1d",
	"outbound_1d",
] as const satisfies readonly (keyof HeartbeatCounts)[];

/** Every field a heartbeat carries, with the words Admin → General and the docs use for it. */
export const TELEMETRY_FIELDS: readonly { key: keyof HeartbeatPayload; description: string }[] = [
	{ key: "telemetry_schema_version", description: "Format of the report (1)" },
	{ key: "install_id", description: "A random ID made when statistics were turned on, not derived from anything" },
	{ key: "version", description: "Kite version, such as 2026.10.26.0" },
	{ key: "runtime", description: "Cloudflare Workers or Node/Docker" },
	{ key: "users_total", description: "Number of accounts that are not disabled" },
	{ key: "users_active_1d", description: "Accounts that signed in or did something in the last day" },
	{ key: "users_active_7d", description: "The same, in the last 7 days" },
	{ key: "users_active_30d", description: "The same, in the last 30 days" },
	{ key: "mailboxes_total", description: "Number of mailboxes" },
	{ key: "mailboxes_active_1d", description: "Mailboxes that received mail or sent it successfully in the last day" },
	{ key: "inbound_1d", description: "Messages received in the last day" },
	{ key: "outbound_1d", description: "Messages sent successfully in the last day" },
	{ key: "modules_enabled", description: "Which modules are on, such as calendar or drive" },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CALENDAR_VERSION = /^\d{4}\.\d{2}\.\d{2}\.\d{1,3}$/;

/** `KITE_TELEMETRY=0` (or `false`, `off`, `no`) turns statistics off whatever the owner chose. Nothing turns them on. */
export function telemetryForcedOff(value: string | undefined): boolean {
	return ["0", "false", "off", "no"].includes((value ?? "").trim().toLowerCase());
}

/**
 * The collector URL: `KITE_TELEMETRY_URL` when set, else the default. Null (nothing is sent) when the override is not
 * an https URL or names a `.invalid` host, a reserved name that never resolves (RFC 2606), which the e2e server uses.
 */
export function telemetryUrl(override: string | undefined): string | null {
	const candidate = override?.trim() || DEFAULT_TELEMETRY_URL;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password) return null;
	if (url.hostname === "invalid" || url.hostname.endsWith(".invalid")) return null;
	return url.toString();
}

/** UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

export function isInstallId(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(MAX_COUNT, Math.max(0, Math.floor(value)));
}

function knownModules(values: readonly unknown[]): ModuleId[] {
	const on = new Set(values);
	return MODULE_IDS.filter((id) => on.has(id));
}

type HeartbeatInput = {
	installId: unknown;
	version: unknown;
	runtime: unknown;
	counts: Partial<Record<keyof HeartbeatCounts, unknown>>;
	modulesEnabled: readonly unknown[];
};

/**
 * The only way a heartbeat body is made: every field is copied by name from an allowlist and coerced to its type,
 * so nothing else in `input` can reach the collector. Null when the install id is not a UUID.
 */
export function buildHeartbeatPayload(input: HeartbeatInput): HeartbeatPayload | null {
	if (!isInstallId(input.installId)) return null;
	const runtime: TelemetryRuntime = input.runtime === "node" ? "node" : "workers";
	const version = typeof input.version === "string" && CALENDAR_VERSION.test(input.version) ? input.version : "unknown";
	const counts = Object.fromEntries(COUNT_FIELDS.map((key) => [key, count(input.counts[key])])) as HeartbeatCounts;
	return {
		telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
		install_id: input.installId,
		version,
		runtime,
		...counts,
		modules_enabled: knownModules(input.modulesEnabled),
	};
}
