/** What a draft card should show for an assistant draft id. */
export type AgentDraftState =
	| { state: "draft" }
	| { state: "sent"; messageId: string | null; subject: string | null; to: string | null }
	| { state: "scheduled"; messageId: string | null; subject: string | null; to: string | null; scheduledAt: string }
	| { state: "sending"; messageId: string | null; subject: string | null; to: string | null }
	| { state: "failed"; messageId: string | null; subject: string | null; to: string | null }
	| { state: "unavailable" };

export type SentDraftMessage = { id: string; status: string; subject: string | null; toAddr: string | null };
export type SentDraftJob = { status: string; scheduledAt: Date | null };

const PENDING_STATUSES = ["queued", "sending"];

/** Delivery has not finished (a delayed queue, or a send in flight): it must never be reported as sent. */
function deliveryPending(message: SentDraftMessage | null, job: SentDraftJob | null): boolean {
	return PENDING_STATUSES.includes(job ? job.status : (message?.status ?? ""));
}

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
	const { message, job } = input;
	if (!input.approvedMessageId) return { state: "unavailable" };
	const details = { messageId: message?.id ?? null, subject: message?.subject ?? null, to: message?.toAddr ?? null };
	if (message?.status === "failed" || job?.status === "failed") return { state: "failed", ...details };
	// An undone send is not a sent message.
	if (job?.status === "cancelled") return { state: "unavailable" };
	if (job?.status === "queued" && job.scheduledAt && job.scheduledAt.getTime() > input.now.getTime())
		return { state: "scheduled", ...details, scheduledAt: job.scheduledAt.toISOString() };
	return { state: deliveryPending(message, job) ? "sending" : "sent", ...details };
}
