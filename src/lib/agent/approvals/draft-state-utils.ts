/** What a draft card should show for an assistant draft id. */
export type AgentDraftState =
	| { state: "draft" }
	| { state: "sent"; messageId: string | null; subject: string | null; to: string | null }
	| { state: "scheduled"; messageId: string | null; subject: string | null; to: string | null; scheduledAt: string }
	| { state: "failed"; messageId: string | null; subject: string | null; to: string | null }
	| { state: "unavailable" };

export type SentDraftMessage = { id: string; status: string; subject: string | null; toAddr: string | null };
export type SentDraftJob = { status: string; scheduledAt: Date | null };

/**
 * State of a draft that is no longer a draft row. `approvedMessageId` is the message a confirmed send
 * approval produced (null when the draft was never sent); `message` and `job` are what the caller may
 * read about it.
 */
export function sentDraftState(input: {
	approvedMessageId: string | null;
	message: SentDraftMessage | null;
	job: SentDraftJob | null;
	now: Date;
}): AgentDraftState {
	if (!input.approvedMessageId) return { state: "unavailable" };
	const details = {
		messageId: input.message?.id ?? null,
		subject: input.message?.subject ?? null,
		to: input.message?.toAddr ?? null,
	};
	if (input.message?.status === "failed" || input.job?.status === "failed") return { state: "failed", ...details };
	if (input.job?.status === "queued" && input.job.scheduledAt && input.job.scheduledAt.getTime() > input.now.getTime())
		return { state: "scheduled", ...details, scheduledAt: input.job.scheduledAt.toISOString() };
	return { state: "sent", ...details };
}
