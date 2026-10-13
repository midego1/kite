import { getEnv } from "@/lib/cloudflare";
import { resumeStalledImports, runImportJob } from "@/lib/import/background";
import type { CapabilityHandler } from "../module-types";
import { resolveImportRefs } from "@/lib/import/refs";

export const importHandlers: Record<string, CapabilityHandler> = {
	processImportJob: (input, ctx) => runImportJob(getEnv(), ctx, (input as { jobId: string }).jobId),
	resumeStalledImports: (_input, ctx) => resumeStalledImports(getEnv(), ctx),
	resolveRefs: resolveImportRefs,
};
