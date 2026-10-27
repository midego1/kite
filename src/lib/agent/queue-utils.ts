export type AgentJobKind = "draft" | "triage" | "line_summary";
export type AgentJobQueueMessage = { kind: "agent.draft" | "agent.triage" | "agent.line_summary"; jobId: string };

const QUEUE_KINDS: Record<AgentJobKind, AgentJobQueueMessage["kind"]> = {
	draft: "agent.draft",
	triage: "agent.triage",
	line_summary: "agent.line_summary",
};

export function agentJobQueueMessage(kind: AgentJobKind, jobId: string): AgentJobQueueMessage {
	return { kind: QUEUE_KINDS[kind], jobId };
}

/** The agent job kind a queue body carries, or null when it is not an agent job (IMAP imports share the queue). */
export function agentJobKindOf(body: unknown): AgentJobKind | null {
	if (typeof body !== "object" || body === null) return null;
	const { kind, jobId } = body as { kind?: unknown; jobId?: unknown };
	if (typeof jobId !== "string") return null;
	if (kind === "agent.draft") return "draft";
	if (kind === "agent.triage") return "triage";
	if (kind === "agent.line_summary") return "line_summary";
	return null;
}

/** Runs the handler for an agent job body and reports whether the body was one. */
export async function dispatchAgentJob(
	body: unknown,
	handlers: Record<AgentJobKind, (jobId: string) => Promise<void>>,
): Promise<boolean> {
	const kind = agentJobKindOf(body);
	if (!kind) return false;
	await handlers[kind]((body as AgentJobQueueMessage).jobId);
	return true;
}
