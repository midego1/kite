/** Heartbeat body, `telemetry_schema_version` 1, as Kite's `buildHeartbeatPayload` makes it. */
export type Heartbeat = {
	telemetry_schema_version: 1;
	install_id: string;
	version: string;
	runtime: "workers" | "node";
	users_total: number;
	users_active_1d: number;
	users_active_7d: number;
	users_active_30d: number;
	mailboxes_total: number;
	mailboxes_active_1d: number;
	inbound_1d: number;
	outbound_1d: number;
	modules_enabled: string[];
};

export type ParseResult = { ok: true; value: Heartbeat } | { ok: false; error: string };

/** A heartbeat is a few hundred bytes; anything larger is refused before it is parsed. */
export const MAX_BODY_BYTES = 2048;

export const COUNT_KEYS = [
	"users_total",
	"users_active_1d",
	"users_active_7d",
	"users_active_30d",
	"mailboxes_total",
	"mailboxes_active_1d",
	"inbound_1d",
	"outbound_1d",
] as const;

const KEYS = new Set<string>([
	"telemetry_schema_version",
	"install_id",
	"version",
	"runtime",
	...COUNT_KEYS,
	"modules_enabled",
]);
const MAX_COUNT = 2_147_483_647;
const MAX_MODULES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^(?:\d{4}\.\d{2}\.\d{2}\.\d{1,3}|unknown)$/;
/** Module ids are short slugs; new Kite modules need no collector change. */
const MODULE_ID = /^[a-z][a-z0-9_-]{0,31}$/;

const fail = (error: string): ParseResult => ({ ok: false, error });

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
}

/**
 * Strict: exactly the schema's keys, each with its type and range, or a refusal naming the first problem. The
 * refusal names a field, never echoes a value.
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
	for (const key of Object.keys(record)) if (!KEYS.has(key)) return fail("unknown_key");
	for (const key of KEYS) if (!Object.hasOwn(record, key)) return fail(`missing_${key}`);
	if (record.telemetry_schema_version !== 1) return fail("unsupported_schema_version");
	if (typeof record.install_id !== "string" || !UUID.test(record.install_id)) return fail("invalid_install_id");
	if (typeof record.version !== "string" || !VERSION.test(record.version)) return fail("invalid_version");
	if (record.runtime !== "workers" && record.runtime !== "node") return fail("invalid_runtime");
	for (const key of COUNT_KEYS) if (!isCount(record[key])) return fail(`invalid_${key}`);
	const modules = record.modules_enabled;
	if (!Array.isArray(modules) || modules.length > MAX_MODULES) return fail("invalid_modules_enabled");
	if (!modules.every((id) => typeof id === "string" && MODULE_ID.test(id))) return fail("invalid_modules_enabled");
	if (new Set(modules).size !== modules.length) return fail("invalid_modules_enabled");
	return { ok: true, value: record as Heartbeat };
}
