import { eq } from "drizzle-orm";
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
