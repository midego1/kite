import { COUNT_KEYS, MAX_BODY_BYTES, parseHeartbeat, type Heartbeat } from "./validate";

export type CollectorEnv = {
	DB: D1Database;
	/** Bearer token for GET /v1/stats, set with `wrangler secret put STATS_TOKEN`. Unset means stats are closed. */
	STATS_TOKEN?: string;
	/** Days `daily` rows are kept; default 400. `installs` rows stay so "installs ever" keeps counting. */
	DAILY_RETENTION_DAYS?: string;
};

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 400;
const NO_STORE = { "Cache-Control": "no-store" };

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const empty = (status: number) => new Response(null, { status, headers: NO_STORE });

const UPSERT_INSTALL = `INSERT INTO installs (install_id, first_seen, last_seen, last_version, last_runtime) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (install_id) DO UPDATE SET last_seen = excluded.last_seen, last_version = excluded.last_version, last_runtime = excluded.last_runtime`;
const UPSERT_DAILY = `INSERT INTO daily (day, install_id, version, runtime, ${COUNT_KEYS.join(", ")}, modules_enabled)
VALUES (${Array.from({ length: COUNT_KEYS.length + 5 }, () => "?").join(", ")})
ON CONFLICT (day, install_id) DO UPDATE SET version = excluded.version, runtime = excluded.runtime, ${COUNT_KEYS.map(
	(key) => `${key} = excluded.${key}`,
).join(", ")}, modules_enabled = excluded.modules_enabled`;

/** Only the validated fields are written, with the collector's own date. Nothing about the request is kept. */
async function storeHeartbeat(db: D1Database, heartbeat: Heartbeat, day: string): Promise<void> {
	await db.batch([
		db.prepare(UPSERT_INSTALL).bind(heartbeat.install_id, day, day, heartbeat.version, heartbeat.runtime),
		db
			.prepare(UPSERT_DAILY)
			.bind(
				day,
				heartbeat.install_id,
				heartbeat.version,
				heartbeat.runtime,
				...COUNT_KEYS.map((key) => heartbeat[key]),
				JSON.stringify(heartbeat.modules_enabled),
			),
	]);
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
	(await db
		.prepare(sql)
		.bind(...values)
		.first<{ value: number | null }>()) ?? { value: 0 };

/** Each install's most recent heartbeat on or after `since`. */
const LATEST = `SELECT * FROM daily AS d WHERE d.day >= ? AND d.day = (SELECT MAX(day) FROM daily WHERE install_id = d.install_id)`;

/** "Active in N days" means a heartbeat dated on or after the UTC day N days ago. */
async function stats(env: CollectorEnv, now: number) {
	const db = env.DB;
	const since = (days: number) => utcDay(now - days * DAY_MS);
	const active = (days: number) =>
		count(db, "SELECT COUNT(DISTINCT install_id) AS value FROM daily WHERE day >= ?", since(days));
	const [total, active1, active7, active30, sums, versions, runtimes, modules] = await Promise.all([
		count(db, "SELECT COUNT(*) AS value FROM installs"),
		active(1),
		active(7),
		active(30),
		db
			.prepare(
				`SELECT COUNT(*) AS installs, ${COUNT_KEYS.map((key) => `COALESCE(SUM(${key}), 0) AS ${key}`).join(", ")} FROM (${LATEST})`,
			)
			.bind(since(1))
			.first<Record<string, number>>(),
		db
			.prepare(
				"SELECT last_version AS version, COUNT(*) AS installs FROM installs WHERE last_seen >= ? GROUP BY last_version ORDER BY installs DESC, version DESC",
			)
			.bind(since(30))
			.all<{ version: string; installs: number }>(),
		db
			.prepare(
				"SELECT last_runtime AS runtime, COUNT(*) AS installs FROM installs WHERE last_seen >= ? GROUP BY last_runtime ORDER BY installs DESC",
			)
			.bind(since(30))
			.all<{ runtime: string; installs: number }>(),
		db
			.prepare(
				`SELECT module.value AS module, COUNT(*) AS installs FROM (${LATEST}) AS latest, json_each(latest.modules_enabled) AS module GROUP BY module.value ORDER BY installs DESC, module ASC`,
			)
			.bind(since(30))
			.all<{ module: string; installs: number }>(),
	]);
	return {
		generated_at: new Date(now).toISOString(),
		installs: {
			total: total.value ?? 0,
			active_1d: active1.value ?? 0,
			active_7d: active7.value ?? 0,
			active_30d: active30.value ?? 0,
		},
		/** Summed over the latest heartbeat of each install active in the last day. */
		usage: sums ?? {},
		/** Installs seen in the last 30 days, by the version and runtime of their latest heartbeat. */
		versions: versions.results,
		runtimes: runtimes.results,
		modules: modules.results,
	};
}

export async function purgeOldDays(env: CollectorEnv, now: number): Promise<void> {
	const days = Number(env.DAILY_RETENTION_DAYS);
	const retention = Number.isInteger(days) && days >= 31 ? days : DEFAULT_RETENTION_DAYS;
	await env.DB.prepare("DELETE FROM daily WHERE day < ?")
		.bind(utcDay(now - retention * DAY_MS))
		.run();
}

export default {
	async fetch(request: Request, env: CollectorEnv): Promise<Response> {
		const { pathname } = new URL(request.url);
		const now = Date.now();
		if (pathname === "/v1/heartbeat") return request.method === "POST" ? heartbeat(request, env, now) : empty(405);
		if (pathname === "/v1/stats") {
			if (request.method !== "GET") return empty(405);
			if (!(await authorized(request, env.STATS_TOKEN))) return empty(401);
			return json(await stats(env, now));
		}
		return empty(404);
	},
	async scheduled(controller: ScheduledController, env: CollectorEnv, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(purgeOldDays(env, controller.scheduledTime));
	},
} satisfies ExportedHandler<CollectorEnv>;
