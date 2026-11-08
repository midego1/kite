/**
 * The agent queue consumer for an accepted request (docs/specs/assistant-by-email.md §4, §8, §9). This Mission
 * ends at intake: nothing here runs the chat engine, sends a reply, or reads the raw object, so the row is left
 * exactly as `acceptAssistantRequest` left it — `queued`, raw object and all — rather than claiming `answered`,
 * which would say a reply was sent when none was. Returning without error still acks the queue message, so a
 * request that passed every intake check is not retried forever waiting for a runner this Mission does not add.
 * A later Mission replaces this body with the non-streaming chat run, the reply, and the raw object's cleanup
 * once it has actually been read.
 */
export async function processAssistantEmailRequest(_env: CloudflareEnv, _requestId: string): Promise<void> {}

/** Whether a queue body is an `agent.assistant_email` message, so `processAgentQueueMessage` can dispatch it. */
export function isAssistantEmailQueueMessage(
	body: unknown,
): body is { kind: "agent.assistant_email"; requestId: string } {
	if (typeof body !== "object" || body === null) return false;
	const { kind, requestId } = body as { kind?: unknown; requestId?: unknown };
	return kind === "agent.assistant_email" && typeof requestId === "string";
}
