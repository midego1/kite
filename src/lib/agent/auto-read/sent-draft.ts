import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions } from "@/db/schema/agent-auto-read";

/**
 * Sending an agent draft trashes the draft row and stores the send under a new message id, so the
 * draft's `create_draft` action records that id in `after.sentMessageId` for Activity to link to.
 */
export async function recordSentAgentDraft(
	env: CloudflareEnv,
	input: { mailboxId: string; draftId: string; sentMessageId: string },
): Promise<void> {
	await getDb(env)
		.update(agentActions)
		.set({
			after: sql`json_set(coalesce(${agentActions.after}, '{}'), '$.sentMessageId', ${input.sentMessageId})`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(agentActions.mailboxId, input.mailboxId),
				eq(agentActions.action, "create_draft"),
				sql`json_extract(${agentActions.after}, '$.draftId') = ${input.draftId}`,
			),
		);
}
