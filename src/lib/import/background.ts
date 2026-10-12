import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { importJobs } from "@/db/schema/import-jobs";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { processImportJob, resumeStalledImportJobs } from "./jobs";

export type ImportBackgroundOutcome = { skipped?: "module_disabled" };

const ownerMayImport = (ctx: CapabilityCallContext, userId: string) =>
	moduleHost.modules.isEnabledFor(ctx, userId, "import");

/**
 * Queue handler for one batch of a job. A job whose owner is restricted from Import is skipped without
 * touching its row, so it resumes unchanged when access returns.
 */
export async function runImportJob(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	jobId: string,
): Promise<ImportBackgroundOutcome> {
	const [job] = await getDb(env)
		.select({ userId: importJobs.userId })
		.from(importJobs)
		.where(eq(importJobs.id, jobId))
		.limit(1);
	if (job && !(await ownerMayImport(ctx, job.userId))) return { skipped: "module_disabled" };
	await processImportJob(env, jobId, ctx);
	return {};
}

/** Cron handler: re-queues stalled jobs, leaving out those of restricted owners. */
export async function resumeStalledImports(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
): Promise<ImportBackgroundOutcome> {
	await resumeStalledImportJobs(env, ctx, (userId) => ownerMayImport(ctx, userId));
	return {};
}
