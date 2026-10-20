import { getEnv } from "@/lib/cloudflare";
import { resolveDriveRefs } from "@/lib/drive/refs";
import { purgeDrive } from "@/lib/drive/retention";
import type { CapabilityHandler, JsonValue } from "../module-types";

function tickTime(input: JsonValue): Date {
	const scheduled = (input as { scheduledTime?: unknown } | null)?.scheduledTime;
	const time = typeof scheduled === "string" ? new Date(scheduled) : new Date();
	return Number.isNaN(time.getTime()) ? new Date() : time;
}

export const driveHandlers: Record<string, CapabilityHandler> = {
	resolveRefs: resolveDriveRefs,
	purgeDrive: async (input) => await purgeDrive(getEnv(), tickTime(input)),
};
