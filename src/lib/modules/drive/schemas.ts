import { z } from "zod";
import type { ModuleSchemas } from "../schema-utils";
import { resolveRefsSchemas } from "../shared-schemas";

export const driveSchemas: ModuleSchemas = {
	resolveRefs: resolveRefsSchemas(["drive:file"]),
	purgeDrive: {
		input: z.object({ scheduledTime: z.string().datetime({ offset: true }).optional() }),
		output: z.object({ trashed: z.number().int().min(0), uploads: z.number().int().min(0) }),
	},
	storageListObjectKeys: {
		input: z.object({
			storeId: z.string().min(1).max(64),
			cursor: z.string().max(64).nullable().optional(),
			limit: z.number().int().min(1).max(200).optional(),
		}),
		output: z.object({
			objects: z.array(z.object({ id: z.string(), key: z.string(), size: z.number().int().min(0) })),
			cursor: z.string().nullable(),
		}),
	},
	storageMarkMoved: {
		input: z.object({
			ids: z.array(z.string().min(1).max(64)).max(200),
			fromStoreId: z.string().min(1).max(64),
			toStoreId: z.string().min(1).max(64),
		}),
		output: z.object({ updated: z.number().int().min(0) }),
	},
	storageCountOnStore: {
		input: z.object({ storeId: z.string().min(1).max(64) }),
		output: z.object({ count: z.number().int().min(0) }),
	},
	storageUsage: {
		input: z.object({}),
		output: z.object({ objects: z.number().int().min(0), bytes: z.number().int().min(0) }),
	},
};
