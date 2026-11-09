import { getEnv } from "@/lib/cloudflare";
import { fileMessageReceipts } from "@/lib/drive/receipts";
import { resolveDriveRefs } from "@/lib/drive/refs";
import { purgeDrive } from "@/lib/drive/retention";
import {
	countDriveObjectsOnStore,
	driveStorageUsage,
	listDriveObjectKeys,
	markDriveObjectsMoved,
} from "@/lib/drive/storage-hooks";
import type { CapabilityHandler, CapabilityCallContext, JsonValue } from "../module-types";

function tickTime(input: JsonValue): Date {
	const scheduled = (input as { scheduledTime?: unknown } | null)?.scheduledTime;
	const time = typeof scheduled === "string" ? new Date(scheduled) : new Date();
	return Number.isNaN(time.getTime()) ? new Date() : time;
}

async function fileReceipt(input: JsonValue, ctx: CapabilityCallContext) {
	if (!ctx.viewer) throw new Error("fileReceipt needs a viewer");
	const value = input as { messageId: string; attachmentId: string | null; folderPath: string[]; baseName: string };
	const result = await fileMessageReceipts(getEnv(), {
		ownerId: ctx.viewer.userId,
		ownerRole: ctx.viewer.role,
		messageId: value.messageId,
		attachmentId: value.attachmentId,
		folderSegments: value.folderPath,
		baseName: value.baseName,
	});
	return result.filed
		? {
				filed: true,
				emlFileId: result.emlFileId,
				htmlFileId: result.htmlFileId,
				pdfFileId: result.pdfFileId,
				attachmentFileId: result.attachmentFileId,
				skippedReason: null,
			}
		: {
				filed: false,
				emlFileId: null,
				htmlFileId: null,
				pdfFileId: null,
				attachmentFileId: null,
				skippedReason: result.skipped,
			};
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
	fileReceipt,
};
