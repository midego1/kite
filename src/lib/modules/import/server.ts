import { getEnv } from "@/lib/cloudflare";
import { processImportJob, resumeStalledImportJobs } from "@/lib/import/jobs";
import type { CapabilityHandler } from "../module-types";
import { resolveImportRefs } from "@/lib/import/refs";

export const importHandlers: Record<string, CapabilityHandler> = {
	processImportJob: async (input) => {
		await processImportJob(getEnv(), (input as { jobId: string }).jobId);
		return {};
	},
	resumeStalledImports: async () => {
		await resumeStalledImportJobs(getEnv());
		return {};
	},
	resolveRefs: resolveImportRefs,
};
