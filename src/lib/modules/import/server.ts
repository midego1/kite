import { getEnv } from "@/lib/cloudflare";
import { processImportJob, resumeStalledImportJobs } from "@/lib/import/jobs";
import { unavailableRefsHandler } from "../handler-helpers";
import type { CapabilityHandler } from "../module-types";

export const importHandlers: Record<string, CapabilityHandler> = {
	processImportJob: async (input) => {
		await processImportJob(getEnv(), (input as { jobId: string }).jobId);
		return {};
	},
	resumeStalledImports: async () => {
		await resumeStalledImportJobs(getEnv());
		return {};
	},
	resolveRefs: unavailableRefsHandler,
};
