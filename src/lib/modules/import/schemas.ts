import { z } from "zod";
import type { ModuleSchemas } from "../schema-utils";
import { resolveRefsSchemas } from "../shared-schemas";

const outcome = z.object({ skipped: z.literal("module_disabled").optional() });

export const importSchemas: ModuleSchemas = {
	processImportJob: {
		input: z.object({ kind: z.literal("import.imap"), jobId: z.string().min(1) }),
		output: outcome,
	},
	resumeStalledImports: { input: z.object({}), output: outcome },
	resolveRefs: resolveRefsSchemas(["import:job"]),
};
