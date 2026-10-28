/** D1's database limit on Workers Paid. Workers Free installs set `D1_MAX_BYTES=500000000`. */
const D1_DEFAULT_MAX_BYTES = 10_000_000_000;
/** Warn from this share of the limit. */
const DATABASE_WARN_RATIO = 0.7;
/** Ask for confirmation before more mail is added from this share of the limit, and pause running imports. */
export const DATABASE_STOP_RATIO = 0.9;

export type DatabaseSize = { usedBytes: number; limitBytes: number | null };
export type DatabaseUseLevel = "ok" | "warn" | "critical";

/** `D1_MAX_BYTES` when it is a positive whole number, else the 10 GB D1 limit. */
export function d1MaxBytes(value: string | undefined): number {
	const parsed = Number(value?.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : D1_DEFAULT_MAX_BYTES;
}

export function databaseUseLevel(usedBytes: number, limitBytes: number | null): DatabaseUseLevel {
	if (!limitBytes || limitBytes <= 0) return "ok";
	const ratio = usedBytes / limitBytes;
	if (ratio >= DATABASE_STOP_RATIO) return "critical";
	if (ratio >= DATABASE_WARN_RATIO) return "warn";
	return "ok";
}

/** `1.9 GB`, `640 MB`, `12 KB`: decimal units, as Cloudflare states the limits. */
export function formatDatabaseBytes(bytes: number): string {
	const value = Math.max(0, bytes);
	if (value >= 1e9) return `${trim(value / 1e9)} GB`;
	if (value >= 1e6) return `${trim(value / 1e6)} MB`;
	if (value >= 1e3) return `${Math.round(value / 1e3)} KB`;
	return `${Math.round(value)} B`;
}

function trim(value: number): string {
	return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

/**
 * Specs and e2e inject a size with `X-Kite-Test-Database-Size: used=<bytes>;limit=<bytes>` (`limit=none` for
 * no limit). Ignored in production.
 */
export const TEST_DATABASE_SIZE_HEADER = "x-kite-test-database-size";

export function parseTestDatabaseSize(
	header: string | null | undefined,
	nodeEnv: string | undefined,
): DatabaseSize | null {
	if (nodeEnv === "production" || !header) return null;
	const fields = new Map(header.split(";").map((part) => part.trim().split("=") as [string, string | undefined]));
	const used = Number(fields.get("used"));
	if (!Number.isFinite(used) || used < 0) return null;
	const limit = fields.get("limit");
	if (limit === "none") return { usedBytes: Math.floor(used), limitBytes: null };
	const limitBytes = Number(limit);
	return Number.isSafeInteger(limitBytes) && limitBytes > 0
		? { usedBytes: Math.floor(used), limitBytes }
		: { usedBytes: Math.floor(used), limitBytes: D1_DEFAULT_MAX_BYTES };
}
