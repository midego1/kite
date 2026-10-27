import { BUCKET_KEYS, isInstallId, MAX_BODY_BYTES, parseHeartbeat, type Heartbeat } from "./validate";

export type CollectorEnv = {
	DB: D1Database;
	/** Bearer token for GET /v1/stats, set with `wrangler secret put STATS_TOKEN`. Unset means stats are closed. */
	STATS_TOKEN?: string;
	/** Limits DELETE /v1/installs/<id> (the `ratelimits` binding in wrangler.jsonc). */
	ERASE_RATE_LIMIT?: RateLimit;
};

const DAY_MS = 86_400_000;
/** Daily rows, which carry the install id, are kept this long, then only `aggregates` without ids. */
export const RAW_RETENTION_DAYS = 90;
/** How far back the public summary lists installs per day. */
const HISTORY_DAYS = 365;
const NO_STORE = { "Cache-Control": "no-store" };
const PUBLIC = { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" };
const INSTALL_PATH = /^\/v1\/installs\/([^/]+)$/;

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const json = (body: unknown, status = 200, headers: HeadersInit = NO_STORE) => Response.json(body, { status, headers });
const empty = (status: number) => new Response(null, { status, headers: NO_STORE });

const UPSERT_DAILY = `INSERT INTO daily (day, install_id, version, runtime, ${BUCKET_KEYS.join(", ")}, modules_enabled)
VALUES (${Array.from({ length: BUCKET_KEYS.length + 5 }, () => "?").join(", ")})
ON CONFLICT (day, install_id) DO UPDATE SET version = excluded.version, runtime = excluded.runtime, ${BUCKET_KEYS.map(
	(key) => `${key} = excluded.${key}`,
).join(", ")}, modules_enabled = excluded.modules_enabled`;

/** Only the validated fields are written, with the collector's own date. Nothing about the request is kept. */
async function storeHeartbeat(db: D1Database, heartbeat: Heartbeat, day: string): Promise<void> {
	await db
		.prepare(UPSERT_DAILY)
		.bind(
			day,
			heartbeat.install_id,
			heartbeat.version,
			heartbeat.runtime,
			...BUCKET_KEYS.map((key) => heartbeat[key]),
			JSON.stringify(heartbeat.modules_enabled),
		)
		.run();
}

async function heartbeat(request: Request, env: CollectorEnv, now: number): Promise<Response> {
	if (!/^application\/json\b/i.test(request.headers.get("Content-Type") ?? "")) return empty(415);
	const length = Number(request.headers.get("Content-Length"));
	if (!Number.isFinite(length) || length <= 0 || length > MAX_BODY_BYTES) return empty(413);
	const parsed = parseHeartbeat(await request.text());
	if (!parsed.ok) return json({ error: parsed.error }, parsed.error === "too_large" ? 413 : 400);
	await storeHeartbeat(env.DB, parsed.value, utcDay(now));
	return empty(204);
}

/**
 * Erasure: knowing the random install id is enough. Deletes every daily row of that id (the aggregates hold no ids)
 * and answers 204 whether or not there were any, so the answer says nothing about which ids exist.
 */
async function eraseInstall(env: CollectorEnv, id: string): Promise<Response> {
	// One shared limit for every caller: the collector never reads IP addresses, so it cannot limit per sender.
	if (env.ERASE_RATE_LIMIT && !(await env.ERASE_RATE_LIMIT.limit({ key: "erase" })).success) return empty(429);
	if (!isInstallId(id)) return json({ error: "invalid_install_id" }, 400);
	await env.DB.prepare("DELETE FROM daily WHERE install_id = ?").bind(id).run();
	return empty(204);
}

async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Compares digests in constant time, so the token cannot be guessed byte by byte. */
async function authorized(request: Request, token: string | undefined): Promise<boolean> {
	const header = request.headers.get("Authorization") ?? "";
	if (!token || !header.startsWith("Bearer ")) return false;
	const [given, expected] = await Promise.all([sha256(header.slice(7)), sha256(token)]);
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) difference |= given[index] ^ expected[index];
	return difference === 0;
}

const count = async (db: D1Database, sql: string, ...values: unknown[]) =>
	(
		await db
			.prepare(sql)
			.bind(...values)
			.first<{ value: number | null }>()
	)?.value ?? 0;

/** Each install's most recent heartbeat on or after `since`. */
const LATEST = `SELECT * FROM daily AS d WHERE d.day >= ? AND d.day = (SELECT MAX(day) FROM daily WHERE install_id = d.install_id)`;
const RANGES = BUCKET_KEYS.map(
	(key) => `SELECT '${key}' AS field, ${key} AS bucket, COUNT(*) AS installs FROM (${LATEST}) GROUP BY ${key}`,
).join(" UNION ALL ");

/**
 * Public totals, never an install id: installs that reported in the last 30 days by the version, runtime, modules and
 * ranges of their latest report, and how many installs reported on each day.
 */
async function summary(db: D1Database, now: number) {
	const since30 = utcDay(now - 30 * DAY_MS);
	const sinceHistory = utcDay(now - HISTORY_DAYS * DAY_MS);
	const [installs, versions, runtimes, modules, ranges, history] = await Promise.all([
		count(db, `SELECT COUNT(*) AS value FROM (${LATEST})`, since30),
		db
			.prepare(
				`SELECT version, COUNT(*) AS installs FROM (${LATEST}) GROUP BY version ORDER BY installs DESC, version DESC`,
			)
			.bind(since30)
			.all<{ version: string; installs: number }>(),
		db
			.prepare(`SELECT runtime, COUNT(*) AS installs FROM (${LATEST}) GROUP BY runtime ORDER BY installs DESC, runtime`)
			.bind(since30)
			.all<{ runtime: string; installs: number }>(),
		db
			.prepare(
				`SELECT module.value AS module, COUNT(*) AS installs FROM (${LATEST}) AS latest, json_each(latest.modules_enabled) AS module GROUP BY module.value ORDER BY installs DESC, module ASC`,
			)
			.bind(since30)
			.all<{ module: string; installs: number }>(),
		db
			.prepare(RANGES)
			.bind(...BUCKET_KEYS.map(() => since30))
			.all<{ field: string; bucket: string; installs: number }>(),
		db
			.prepare(
				`SELECT day, COUNT(*) AS installs FROM daily WHERE day >= ? GROUP BY day
				UNION ALL SELECT day, installs FROM aggregates WHERE dimension = 'installs' AND day >= ? ORDER BY day`,
			)
			.bind(sinceHistory, sinceHistory)
			.all<{ day: string; installs: number }>(),
	]);
	const byField: Record<string, Record<string, number>> = Object.fromEntries(BUCKET_KEYS.map((key) => [key, {}]));
	for (const { field, bucket, installs: n } of ranges.results) byField[field][bucket] = n;
	return {
		generated_at: new Date(now).toISOString(),
		installs_30d: installs,
		versions: versions.results,
		runtimes: runtimes.results,
		modules: modules.results,
		/** Per field, how many installs' latest report fell in each range. */
		ranges: byField,
		installs_by_day: history.results,
	};
}

/** The summary plus how many installs are active, for the operator. "Active in N days": a report on or after that UTC day. */
async function stats(db: D1Database, now: number) {
	const active = (days: number) =>
		count(db, "SELECT COUNT(DISTINCT install_id) AS value FROM daily WHERE day >= ?", utcDay(now - days * DAY_MS));
	const [total, active1, active7, active30, totals] = await Promise.all([
		count(db, "SELECT COUNT(DISTINCT install_id) AS value FROM daily"),
		active(1),
		active(7),
		active(30),
		summary(db, now),
	]);
	return { ...totals, installs: { total, active_1d: active1, active_7d: active7, active_30d: active30 } };
}

const rollUp = (dimension: string, value: string, from = "daily", where = "day < ?", group = value) =>
	`INSERT INTO aggregates (day, dimension, value, installs)
	SELECT day, '${dimension}', ${value}, COUNT(*) FROM ${from} WHERE ${where} GROUP BY day, ${group}
	ON CONFLICT (day, dimension, value) DO UPDATE SET installs = installs + excluded.installs`;

/**
 * Retention, from the daily cron: daily rows older than `RAW_RETENTION_DAYS` are counted into `aggregates` (no install
 * ids) and deleted, in one transaction.
 */
export async function rollUpOldDays(env: CollectorEnv, now: number): Promise<void> {
	const cutoff = utcDay(now - RAW_RETENTION_DAYS * DAY_MS);
	const statements = [
		rollUp("installs", "''", "daily", "day < ?", "day"),
		rollUp("version", "version"),
		rollUp("runtime", "runtime"),
		rollUp("module", "module.value", "daily, json_each(daily.modules_enabled) AS module"),
		...BUCKET_KEYS.map((key) => rollUp(key, key)),
		"DELETE FROM daily WHERE day < ?",
	];
	await env.DB.batch(statements.map((sql) => env.DB.prepare(sql).bind(cutoff)));
}

export default {
	async fetch(request: Request, env: CollectorEnv): Promise<Response> {
		const { pathname } = new URL(request.url);
		const now = Date.now();
		if (pathname === "/v1/heartbeat") return request.method === "POST" ? heartbeat(request, env, now) : empty(405);
		const install = INSTALL_PATH.exec(pathname);
		if (install) return request.method === "DELETE" ? eraseInstall(env, install[1]) : empty(405);
		if (pathname === "/v1/summary") {
			if (request.method !== "GET") return empty(405);
			return json(await summary(env.DB, now), 200, PUBLIC);
		}
		if (pathname === "/v1/stats") {
			if (request.method !== "GET") return empty(405);
			if (!(await authorized(request, env.STATS_TOKEN))) return empty(401);
			return json(await stats(env.DB, now));
		}
		return empty(404);
	},
	async scheduled(controller: ScheduledController, env: CollectorEnv, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(rollUpOldDays(env, controller.scheduledTime));
	},
} satisfies ExportedHandler<CollectorEnv>;
