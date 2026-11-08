import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { assistantEmailRequests } from "@/db/schema/assistant-email";

/**
 * The agent queue consumer for an accepted request (docs/specs/assistant-by-email.md §4, §8, §9). This Mission
 * ends at intake: a request that reaches here is simply marked `answered`/`accepted_pending_runner` without a
 * reply, a chat run, or a model call. A later Mission replaces this body with the non-streaming chat run, the
 * reply and the deep link to the assistant panel.
 */
export async function processAssistantEmailRequest(env: CloudflareEnv, requestId: string): Promise<void> {
	const db = getDb(env);
	const [row] = await db
		.select({ rawR2Key: assistantEmailRequests.rawR2Key })
		.from(assistantEmailRequests)
		.where(eq(assistantEmailRequests.id, requestId))
		.limit(1);
	if (!row) return; // Already pruned or removed; nothing left to finish.
	if (row.rawR2Key)
		await env.BUCKET.delete(row.rawR2Key).catch((error) => console.error("Assistant email raw delete", error));
	await db
		.update(assistantEmailRequests)
		.set({ status: "answered", reason: "accepted_pending_runner", rawR2Key: null, completedAt: new Date() })
		.where(eq(assistantEmailRequests.id, requestId));
}

/** Whether a queue body is an `agent.assistant_email` message, so `processAgentQueueMessage` can dispatch it. */
export function isAssistantEmailQueueMessage(
	body: unknown,
): body is { kind: "agent.assistant_email"; requestId: string } {
	if (typeof body !== "object" || body === null) return false;
	const { kind, requestId } = body as { kind?: unknown; requestId?: unknown };
	return kind === "agent.assistant_email" && typeof requestId === "string";
}
