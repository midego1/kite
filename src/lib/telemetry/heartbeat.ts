import { BUILD_VERSION } from "@/lib/build-version";
import { createLogger } from "@/lib/logger.mjs";
import { listEnabledModules } from "@/lib/modules/state";
import { isNodeRuntime } from "@/lib/runtime";
import { eraseTelemetryInstall } from "./erase";
import { claimTelemetryDay, readTelemetryState } from "./state";
import {
	buildHeartbeatPayload,
	TELEMETRY_TIMEOUT_MS,
	telemetryForcedOff,
	telemetryUrl,
	utcDay,
} from "./telemetry-utils";
import type { HeartbeatCounts } from "./types";

const logger = createLogger("telemetry");
const DAY_SECONDS = 86_400;

/**
 * Counts only. Activity is a sign-in (a new session) or any audited action (reading, sending, deleting, settings) by
 * the account; `messages` is read through `messages_user_created_idx` (one range per account). Outbound rows count
 * only once delivered (`sent`): drafts, templates and queued or failed sends are not mail that moved.
 */
const COUNTS_SQL = `WITH activity(user_id, at) AS (
	SELECT actor_user_id, created_at FROM audit_logs WHERE actor_user_id IS NOT NULL AND created_at >= ?
	UNION ALL
	SELECT user_id, created_at FROM sessions WHERE created_at >= ?
), recent AS (
	SELECT mailbox_id, direction FROM messages
	WHERE user_id IN (SELECT id FROM users) AND created_at >= ?
		AND ((direction = 'inbound' AND status NOT IN ('draft', 'template')) OR (direction = 'outbound' AND status = 'sent'))
)
SELECT
	(SELECT COUNT(*) FROM users WHERE disabled = 0) AS users_total,
	(SELECT COUNT(DISTINCT user_id) FROM activity WHERE at >= ?) AS users_active_1d,
	(SELECT COUNT(DISTINCT user_id) FROM activity WHERE at >= ?) AS users_active_7d,
	(SELECT COUNT(DISTINCT user_id) FROM activity) AS users_active_30d,
	(SELECT COUNT(*) FROM mailboxes) AS mailboxes_total,
	(SELECT COUNT(DISTINCT mailbox_id) FROM recent WHERE mailbox_id IS NOT NULL) AS mailboxes_active_1d,
	(SELECT COUNT(*) FROM recent WHERE direction = 'inbound') AS inbound_1d,
	(SELECT COUNT(*) FROM recent WHERE direction = 'outbound') AS outbound_1d`;

async function collectHeartbeatCounts(env: Pick<CloudflareEnv, "DB">, now: Date): Promise<HeartbeatCounts> {
	const seconds = Math.floor(now.getTime() / 1000);
	const [day, week, month] = [1, 7, 30].map((days) => seconds - days * DAY_SECONDS);
	// Positional parameters in the order they appear: better-sqlite3 (Node) does not accept numbered ones.
	const row = await env.DB.prepare(COUNTS_SQL).bind(month, month, day, day, week).first<HeartbeatCounts>();
	if (!row) throw new Error("telemetry counts unavailable");
	return row;
}

type Outcome = "disabled" | "forced_off" | "no_endpoint" | "already_sent" | "sent" | "rejected" | "failed";

async function sendHeartbeat(env: CloudflareEnv, now: Date, fetcher: typeof fetch): Promise<Outcome> {
	if (telemetryForcedOff(env.KITE_TELEMETRY)) return "forced_off";
	const endpoint = telemetryUrl(env.KITE_TELEMETRY_URL);
	if (!endpoint) return "no_endpoint";
	const state = await readTelemetryState(env);
	if (!state.available || !state.enabled) return "disabled";
	if (!(await claimTelemetryDay(env, utcDay(now)))) return "already_sent";
	const payload = buildHeartbeatPayload({
		installId: state.installId,
		version: BUILD_VERSION,
		runtime: isNodeRuntime(env) ? "node" : "workers",
		counts: await collectHeartbeatCounts(env, now),
		modulesEnabled: await listEnabledModules(env, null),
	});
	if (!payload) return "disabled";
	// Counting can take a while: an opt-out (or an off/on that made a new id) in the meantime wins.
	const current = await readTelemetryState(env);
	if (!current.enabled || current.installId !== state.installId) return "disabled";
	const response = await fetcher(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		redirect: "error",
		signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
	});
	// The body is never read: nothing the collector answers is used or logged.
	await response.body?.cancel();
	if (!response.ok) return "rejected";
	// An opt-out (or off and on again) that landed while the report was on its way: its own erasure request may have
	// reached the collector first, so erase this report too.
	if ((await readTelemetryState(env)).installId !== payload.install_id)
		await eraseTelemetryInstall(endpoint, payload.install_id, fetcher);
	return "sent";
}

/**
 * The daily usage heartbeat, from the 02:00 UTC cron on both runtimes. Never throws and never retries: a failure
 * waits for the next day. Logs a fixed outcome only, never a response, an error message or a payload value.
 */
export async function runTelemetryHeartbeat(
	env: CloudflareEnv,
	now: Date = new Date(),
	fetcher: typeof fetch = fetch,
): Promise<Outcome> {
	let outcome: Outcome;
	try {
		outcome = await sendHeartbeat(env, now, fetcher);
	} catch {
		outcome = "failed";
	}
	if (outcome === "sent") logger.info("telemetry.heartbeat_sent", {});
	else if (outcome === "rejected" || outcome === "failed") logger.warn("telemetry.heartbeat_failed", { outcome });
	return outcome;
}
