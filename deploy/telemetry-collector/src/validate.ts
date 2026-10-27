/** Ranges of account and mailbox counts, as Kite's `accountBucket` makes them. `100+` means more than 100. */
export const ACCOUNT_BUCKETS = ["0", "1", "2-5", "6-20", "21-100", "100+"] as const;
/** Ranges of message counts, as Kite's `messageBucket` makes them. `1000+` means more than 1,000. */
export const MESSAGE_BUCKETS = ["0", "1-10", "11-100", "101-1000", "1000+"] as const;

type AccountBucket = (typeof ACCOUNT_BUCKETS)[number];
type MessageBucket = (typeof MESSAGE_BUCKETS)[number];

/** Heartbeat body, `telemetry_schema_version` 2, as Kite's `buildHeartbeatPayload` makes it. */
export type Heartbeat = {
	telemetry_schema_version: 2;
	install_id: string;
	version: string;
	runtime: "workers" | "node";
	users_total: AccountBucket;
	users_active_1d: AccountBucket;
	users_active_7d: AccountBucket;
	users_active_30d: AccountBucket;
	mailboxes_total: AccountBucket;
	mailboxes_active_1d: AccountBucket;
	inbound_1d: MessageBucket;
	outbound_1d: MessageBucket;
	modules_enabled: string[];
};

export type ParseResult = { ok: true; value: Heartbeat } | { ok: false; error: string };

/** A heartbeat is a few hundred bytes; anything larger is refused before it is parsed. */
export const MAX_BODY_BYTES = 2048;

export const ACCOUNT_KEYS = [
	"users_total",
	"users_active_1d",
	"users_active_7d",
	"users_active_30d",
	"mailboxes_total",
	"mailboxes_active_1d",
] as const;
export const MESSAGE_KEYS = ["inbound_1d", "outbound_1d"] as const;
/** Every field that holds a range, in column order. */
export const BUCKET_KEYS = [...ACCOUNT_KEYS, ...MESSAGE_KEYS] as const;

const KEYS = new Set<string>([
	"telemetry_schema_version",
	"install_id",
	"version",
	"runtime",
	...BUCKET_KEYS,
	"modules_enabled",
]);
const MAX_MODULES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^(?:\d{4}\.\d{2}\.\d{2}\.\d{1,3}|unknown)$/;
/** Module ids are short slugs; new Kite modules need no collector change. */
const MODULE_ID = /^[a-z][a-z0-9_-]{0,31}$/;

const fail = (error: string): ParseResult => ({ ok: false, error });
const oneOf = (values: readonly string[], value: unknown) => typeof value === "string" && values.includes(value);

/** A lowercase UUID v4, the only form of install id Kite makes. */
export function isInstallId(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

/**
 * Strict: exactly the schema's keys, each with its type and range, or a refusal naming the first problem. The
 * refusal names a field, never echoes a value. Version 1, which carried exact counts, is refused.
 */
export function parseHeartbeat(body: string): ParseResult {
	if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return fail("too_large");
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		return fail("invalid_json");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return fail("not_an_object");
	const record = data as Record<string, unknown>;
	if (record.telemetry_schema_version !== 2) return fail("unsupported_schema_version");
	for (const key of Object.keys(record)) if (!KEYS.has(key)) return fail("unknown_key");
	for (const key of KEYS) if (!Object.hasOwn(record, key)) return fail(`missing_${key}`);
	if (!isInstallId(record.install_id)) return fail("invalid_install_id");
	if (typeof record.version !== "string" || !VERSION.test(record.version)) return fail("invalid_version");
	if (record.runtime !== "workers" && record.runtime !== "node") return fail("invalid_runtime");
	for (const key of ACCOUNT_KEYS) if (!oneOf(ACCOUNT_BUCKETS, record[key])) return fail(`invalid_${key}`);
	for (const key of MESSAGE_KEYS) if (!oneOf(MESSAGE_BUCKETS, record[key])) return fail(`invalid_${key}`);
	const modules = record.modules_enabled;
	if (!Array.isArray(modules) || modules.length > MAX_MODULES) return fail("invalid_modules_enabled");
	if (!modules.every((id) => typeof id === "string" && MODULE_ID.test(id))) return fail("invalid_modules_enabled");
	if (new Set(modules).size !== modules.length) return fail("invalid_modules_enabled");
	return { ok: true, value: record as Heartbeat };
}
