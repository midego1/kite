import { getEnv } from "@/lib/cloudflare";
import { resolveDriveRefs } from "@/lib/drive/refs";
import { purgeDrive } from "@/lib/drive/retention";
import {
	countDriveObjectsOnStore,
	driveStorageUsage,
	listDriveObjectKeys,
	markDriveObjectsMoved,
} from "@/lib/drive/storage-hooks";
import type { CapabilityHandler, JsonValue } from "../module-types";

function tickTime(input: JsonValue): Date {
	const scheduled = (input as { scheduledTime?: unknown } | null)?.scheduledTime;
	const time = typeof scheduled === "string" ? new Date(scheduled) : new Date();
	return Number.isNaN(time.getTime()) ? new Date() : time;
}

export const driveHandlers: Record<string, CapabilityHandler> = {
	resolveRefs: resolveDriveRefs,
	purgeDrive: async (input) => await purgeDrive(getEnv(), tickTime(input)),
	storageListObjectKeys: async (input) =>
		await listDriveObjectKeys(getEnv(), input as Parameters<typeof listDriveObjectKeys>[1]),
	storageMarkMoved: async (input) =>
		await markDriveObjectsMoved(getEnv(), input as Parameters<typeof markDriveObjectsMoved>[1]),
	storageCountOnStore: async (input) =>
		await countDriveObjectsOnStore(getEnv(), input as Parameters<typeof countDriveObjectsOnStore>[1]),
	storageUsage: async () => await driveStorageUsage(getEnv()),
};
