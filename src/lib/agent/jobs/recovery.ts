import { and, eq, lt, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { agentJobs } from "@/db/schema";
import { processAgentQueueMessage } from "../queue";
import { agentJobQueueMessage, type AgentJobQueueMessage } from "../queue-utils";

/** Re-runs due pending jobs and running jobs whose lease expired, each under its own kind's queue message. */
export async function recoverAgentJobs(
	env: CloudflareEnv,
	dispatch: (message: AgentJobQueueMessage) => Promise<unknown> = (message) => processAgentQueueMessage(env, message),
) {
	const now = new Date();
	const due = await getDb(env)
		.select({ id: agentJobs.id, kind: agentJobs.kind })
		.from(agentJobs)
		.where(
			or(
				and(eq(agentJobs.status, "pending"), lte(agentJobs.nextAttemptAt, now)),
				and(eq(agentJobs.status, "running"), lt(agentJobs.leaseUntil, now)),
			),
		)
		.limit(20);
	await Promise.allSettled(due.map(({ id, kind }) => dispatch(agentJobQueueMessage(kind, id))));
}
