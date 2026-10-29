import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { outboundJobs } from "@/db/schema";

/** Whether the job is still claimed (`sending`), that is, nothing took the send back since it was claimed. */
export async function isJobClaimed(db: AppDatabase, jobId: string): Promise<boolean> {
	const [job] = await db
		.select({ status: outboundJobs.status })
		.from(outboundJobs)
		.where(eq(outboundJobs.id, jobId))
		.limit(1);
	return job?.status === "sending";
}

/**
 * Renews a claimed job's `updatedAt` while its delivery is still under way, so a slow provider never makes the send
 * look stalled (`STUCK_SENDING_AFTER_MS`) and taken back while it may still be delivered. False when the job is no
 * longer claimed: it was taken back, and nothing more may be sent.
 */
export async function renewJobClaim(db: AppDatabase, jobId: string): Promise<boolean> {
	const renewed = await db
		.update(outboundJobs)
		.set({ updatedAt: new Date() })
		.where(and(eq(outboundJobs.id, jobId), eq(outboundJobs.status, "sending")))
		.returning({ id: outboundJobs.id });
	return renewed.length > 0;
}
