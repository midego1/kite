import { createLogger } from "@/lib/logger.mjs";
import { TELEMETRY_TIMEOUT_MS, telemetryEraseUrl, telemetryUrl } from "./telemetry-utils";
import type { TelemetryErasure } from "./types";

const logger = createLogger("telemetry");

type EraseOutcome = "erased" | "rejected" | "failed" | "no_endpoint";

/**
 * Asks the collector at `endpoint` to delete every report of `installId` (`DELETE /v1/installs/<id>`). Never throws
 * and never reads the answer's body; logs a fixed code only, never the id, a response or an error message.
 */
export async function eraseTelemetryInstall(
	endpoint: string | null,
	installId: string,
	fetcher: typeof fetch = fetch,
): Promise<EraseOutcome> {
	let outcome: EraseOutcome;
	const url = endpoint ? telemetryEraseUrl(endpoint, installId) : null;
	if (!url) outcome = "no_endpoint";
	else
		try {
			const response = await fetcher(url, {
				method: "DELETE",
				redirect: "error",
				signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
			});
			await response.body?.cancel();
			outcome = response.ok ? "erased" : "rejected";
		} catch {
			outcome = "failed";
		}
	if (outcome === "erased") logger.info("telemetry.erase_sent", {});
	else logger.warn("telemetry.erase_failed", { outcome });
	return outcome;
}

/**
 * Best effort, after the owner turned statistics off: erase what the collector holds for the id that was just
 * deleted. Only called out when a heartbeat was ever attempted with that id (`lastSentDay`), so an install that never
 * reported makes no request, also under `KITE_TELEMETRY=0`. A failure never undoes the opt-out; the id is returned so
 * the owner can ask for the erasure by email instead.
 */
export async function eraseAfterOptOut(
	env: Pick<CloudflareEnv, "KITE_TELEMETRY_URL">,
	previous: { installId: string | null; lastSentDay: string | null },
	fetcher: typeof fetch = fetch,
): Promise<TelemetryErasure> {
	if (!previous.installId || !previous.lastSentDay) return { outcome: "not_needed", installId: null };
	const outcome = await eraseTelemetryInstall(telemetryUrl(env.KITE_TELEMETRY_URL), previous.installId, fetcher);
	return outcome === "erased"
		? { outcome: "erased", installId: previous.installId }
		: { outcome: "failed", installId: previous.installId };
}
