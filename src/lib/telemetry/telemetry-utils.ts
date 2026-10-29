import { MODULE_IDS } from "@/lib/modules/client-data/module-ids";
import type { ModuleId } from "@/lib/modules/module-types";
import type {
	AccountBucket,
	HeartbeatBuckets,
	HeartbeatCounts,
	HeartbeatPayload,
	TelemetryDecision,
	TelemetryRuntime,
} from "./types";

const TELEMETRY_SCHEMA_VERSION = 2;

/**
 * Where heartbeats go unless `KITE_TELEMETRY_URL` is set: the collector in `deploy/telemetry-collector/`, run by
 * the Kite project on Cloudflare. Nothing else is ever contacted for statistics.
 */
export const DEFAULT_TELEMETRY_URL = "https://kite-telemetry.midego.net/v1/heartbeat";
/** The default collector's public totals (no install ids), so anyone can see what the reports add up to. */
export const TELEMETRY_SUMMARY_URL = "https://kite-telemetry.midego.net/v1/summary";

/** Where data requests about the default collector go, as the card and the setup name it. */
export const TELEMETRY_PRIVACY_CONTACT = "privacy@midego.net";

/** Audit actions of the owner's choice, listed in Admin → Activity. */
export const TELEMETRY_AUDIT_ACTIONS = ["telemetry.enabled", "telemetry.disabled"] as const;

/** The daily heartbeat runs at this hour, UTC (the `0 2 * * *` cron on Workers, the scheduler on Node). */
const TELEMETRY_RUN_HOUR_UTC = 2;

/** A heartbeat or an erasure request that takes longer is abandoned. */
export const TELEMETRY_TIMEOUT_MS = 5_000;

/** Account and mailbox counts are sent as one of these ranges. `100+` means more than 100. */
const ACCOUNT_BUCKETS = ["0", "1", "2-5", "6-20", "21-100", "100+"] as const;
/** The highest value of each range but the last, in the order of the labels above. */
const ACCOUNT_BOUNDS = [0, 1, 5, 20, 100];

const ACCOUNT_FIELDS = [
	"users_total",
	"users_active_1d",
	"users_active_7d",
	"users_active_30d",
	"mailboxes_total",
	"mailboxes_active_1d",
] as const satisfies readonly (keyof HeartbeatCounts)[];

const ACCOUNT_RANGES = "as a range: 0, 1, 2-5, 6-20, 21-100 or 100+";

/** Every field a heartbeat carries, with the words Admin → General and the docs use for it. */
export const TELEMETRY_FIELDS: readonly { key: keyof HeartbeatPayload; description: string }[] = [
	{ key: "telemetry_schema_version", description: "Format of the report (2)" },
	{ key: "install_id", description: "A random ID made when statistics were turned on, not derived from anything" },
	{ key: "version", description: "Kite version, such as 2026.10.26.0" },
	{ key: "runtime", description: "Cloudflare Workers or Node/Docker" },
	{ key: "users_total", description: `Accounts that are not disabled, ${ACCOUNT_RANGES}` },
	{
		key: "users_active_1d",
		description: `Accounts that signed in or did something in the last day, ${ACCOUNT_RANGES}`,
	},
	{ key: "users_active_7d", description: "The same, in the last 7 days" },
	{ key: "users_active_30d", description: "The same, in the last 30 days" },
	{ key: "mailboxes_total", description: `Mailboxes, ${ACCOUNT_RANGES}` },
	{ key: "mailboxes_active_1d", description: "Mailboxes that received mail or sent it successfully in the last day" },
	{ key: "modules_enabled", description: "Which modules are on, such as calendar or drive" },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CALENDAR_VERSION = /^\d{4}\.\d{2}\.\d{2}\.\d{1,3}$/;

/**
 * `KITE_TELEMETRY=0` (or `false`, `off`, `no`) keeps statistics from being turned on or sent, whatever the owner
 * chose. Nothing turns them on, and the owner can still turn them off.
 */
export function telemetryForcedOff(value: string | undefined): boolean {
	return ["0", "false", "off", "no"].includes((value ?? "").trim().toLowerCase());
}

/**
 * The collector URL. Unset `KITE_TELEMETRY_URL` means the default collector and nothing else; a set value replaces
 * it. Null (nothing is sent) when the value is empty, is not an https URL, carries credentials or names a `.invalid`
 * host, a reserved name that never resolves (RFC 2606), which the e2e server uses.
 */
export function telemetryUrl(override: string | undefined): string | null {
	if (override === undefined) return DEFAULT_TELEMETRY_URL;
	const candidate = override.trim();
	if (!candidate) return null;
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

/**
 * Where an install's reports are erased: `installs/<id>` next to the heartbeat path, so
 * `https://host/v1/heartbeat` becomes `https://host/v1/installs/<id>`. Null for an id that is not a UUID.
 */
export function telemetryEraseUrl(endpoint: string, installId: string): string | null {
	if (!isInstallId(installId)) return null;
	return new URL(`installs/${installId}`, endpoint).toString();
}

/** UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

export function isInstallId(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

const DAY_MS = 86_400_000;

/** The moment of the daily run on a UTC day, which is when statistics start on that day. */
function telemetryRunTime(day: string): number {
	return Date.parse(`${day}T${String(TELEMETRY_RUN_HOUR_UTC).padStart(2, "0")}:00:00Z`);
}

/** The owner always has at least this long between seeing the notice and the first report. */
const TELEMETRY_MIN_LEAD_MS = 60 * 60_000;

/**
 * The day an undecided install starts sending when the owner first sees the notice at `now`: the UTC day of the
 * first 02:00 UTC run more than an hour after `now`. So a notice first seen before 01:00 UTC starts with tonight's
 * run, one seen from 01:00 UTC on (including 01:59) with tomorrow's. Nothing is ever sent before the notice was on
 * screen, and nothing waits longer than a day and an hour after it. Server and browser both use this one rule.
 */
export function telemetryStartDay(now: Date): string {
	const earliest = new Date(now.getTime() + TELEMETRY_MIN_LEAD_MS);
	const day = utcDay(earliest);
	return earliest.getTime() < telemetryRunTime(day) ? day : utcDay(new Date(telemetryRunTime(day) + DAY_MS));
}

/**
 * The date an undecided install that was told earlier moves to when this rule first runs on it, or null when it keeps
 * its date. A start day announced under the earlier 14-day rule is later than the day the first 02:00 UTC run more
 * than an hour from `now` gives, so it moves to that day; a date that rule already gave is never later than it, so
 * running this again changes nothing. Only an undecided install with a start day (one that was told, so a notice was
 * on screen) is touched, and a date only ever moves earlier. A decision, on or off, is never revisited.
 */
export function telemetryEarlierStartDay(choice: TelemetryChoice, now: Date): string | null {
	if (choice.decision !== null || choice.startDay === null) return null;
	const day = telemetryStartDay(now);
	return day < choice.startDay ? day : null;
}

/** `2026-11-12` as `12 November 2026`, the same everywhere: the day is a UTC day. */
export function telemetryDayLabel(day: string): string {
	return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
		new Date(`${day}T00:00:00Z`),
	);
}

/**
 * The start moment in another time zone, such as `30 October 2026 at 04:00`, or null when it reads the same as in UTC
 * (the notice then says nothing more). The day and hour are the ones of the 02:00 UTC run, whatever the zone.
 */
export function telemetryLocalStart(day: string, timeZone: string): string | null {
	const format = (zone: string) =>
		new Intl.DateTimeFormat("en-GB", {
			day: "numeric",
			month: "long",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZone: zone,
		}).format(new Date(telemetryRunTime(day)));
	try {
		const local = format(timeZone);
		return local === format("UTC") ? null : local.replace(",", " at");
	} catch {
		return null;
	}
}

/** The sentence the one-time notice for an existing install leads with. */
export function telemetryNoticeText(startDay: string): string {
	return `Kite will start sending usage statistics from 02:00 UTC on ${telemetryDayLabel(startDay)} unless you turn them off.`;
}

/** The stored parts of the choice the rules below read. */
export type TelemetryChoice = { decision: TelemetryDecision | null; startDay: string | null; noticeDismissed: boolean };

/**
 * What an undecided install's start day means at `now`. `wait`: no start day (the owner was never told), a decision
 * (an explicit `off` stays off) or the start day's 02:00 UTC run has not come. `start`: the day has come and statistics turn on. `expire`:
 * the day came while `KITE_TELEMETRY` forced statistics off or no collector address was usable, so nothing could
 * start; the date is cleared, never acted on later, and the notice comes back with a new one once it is due again.
 */
export function telemetryStartDayOutcome(
	choice: TelemetryChoice,
	now: Date,
	context: { forcedOff: boolean; endpoint: string | null },
): "wait" | "start" | "expire" {
	if (choice.decision !== null || choice.startDay === null || now.getTime() < telemetryRunTime(choice.startDay))
		return "wait";
	return context.forcedOff || context.endpoint === null ? "expire" : "start";
}

/**
 * Whether the primary admin gets the one-time notice: only while undecided and not dismissed, only when something
 * would actually be sent, and only once migration 0075 can store that it was shown.
 */
export function telemetryNoticeDue(
	choice: TelemetryChoice,
	context: { noticeAvailable: boolean; forcedOff: boolean; endpoint: string | null },
): boolean {
	return (
		context.noticeAvailable &&
		!context.forcedOff &&
		context.endpoint !== null &&
		choice.decision === null &&
		!choice.noticeDismissed
	);
}

/**
 * What finishing the first-run setup records. The setup page sends the switch; a request without it (an API
 * client that never showed the notice) and a deployment with `KITE_TELEMETRY=0` record nothing, so the install
 * stays undecided and gets the notice like an upgraded one.
 */
export function setupTelemetryDecision(requested: unknown, forcedOff: boolean): TelemetryDecision | null {
	if (forcedOff || typeof requested !== "boolean") return null;
	return requested ? "on" : "off";
}

function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function bucket<T extends string>(labels: readonly T[], bounds: readonly number[], value: unknown): T {
	const index = bounds.findIndex((bound) => count(value) <= bound);
	return labels[index === -1 ? labels.length - 1 : index];
}

/** The range an account or mailbox count is sent as. */
function accountBucket(value: unknown): AccountBucket {
	return bucket(ACCOUNT_BUCKETS, ACCOUNT_BOUNDS, value);
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
 * and every count is replaced by its range, so nothing else in `input` and no exact number can reach the collector.
 * Null when the install id is not a UUID.
 */
export function buildHeartbeatPayload(input: HeartbeatInput): HeartbeatPayload | null {
	if (!isInstallId(input.installId)) return null;
	const runtime: TelemetryRuntime = input.runtime === "node" ? "node" : "workers";
	const version = typeof input.version === "string" && CALENDAR_VERSION.test(input.version) ? input.version : "unknown";
	const buckets = Object.fromEntries([
		...ACCOUNT_FIELDS.map((key) => [key, accountBucket(input.counts[key])]),
	]) as HeartbeatBuckets;
	return {
		telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
		install_id: input.installId,
		version,
		runtime,
		...buckets,
		modules_enabled: knownModules(input.modulesEnabled),
	};
}
