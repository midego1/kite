import { z } from "zod";
import type { ModuleSchemas } from "../schema-utils";
import { resolveRefsSchemas } from "../shared-schemas";

export const driveSchemas: ModuleSchemas = {
	resolveRefs: resolveRefsSchemas(["drive:file"]),
	purgeDrive: {
		input: z.object({ scheduledTime: z.string().datetime({ offset: true }).optional() }),
		output: z.object({ trashed: z.number().int().min(0), uploads: z.number().int().min(0) }),
	},
};
