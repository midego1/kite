/** A message held in the outbound queue: scheduled, or waiting out the undo window. */
export const PENDING_SEND_STATUS = "queued";
/** A message the provider refused or that could not be sent. */
export const FAILED_SEND_STATUS = "failed";

/**
 * What the Sent folder lists: what went out, what is still waiting to go out and what failed to. They
 * are shared with everyone who can read the mailbox, unlike drafts.
 */
export const SENT_FOLDER_STATUSES = ["sent", PENDING_SEND_STATUS, FAILED_SEND_STATUS] as const;

export function isSentFolderStatus(status: string): boolean {
	return (SENT_FOLDER_STATUSES as readonly string[]).includes(status);
}

/** The `status` filter value of the Sent folder: a comma-separated list. */
export const SENT_FOLDER_STATUS_PARAM = SENT_FOLDER_STATUSES.join(",");

/** The longest undo window a user can pick, in seconds (`UNDO_SEND_SECONDS_OPTIONS`). */
const LONGEST_UNDO_HOLD_MS = 30_000;

/** The outbound state of a message that has not been sent yet, or failed to be. */
export type SendState = {
	status: typeof PENDING_SEND_STATUS | typeof FAILED_SEND_STATUS;
	/** When the queued message goes out; null for a failed one without a schedule. */
	scheduledAt: string | null;
	/** The viewer wrote it, so only they can cancel or edit it. */
	own: boolean;
	/** Why it failed; only its author is told. */
	error?: string | null;
};

/** Splits a `status` filter into its statuses; null when the value is empty. */
export function parseStatusFilter(value: string | null): string[] | null {
	const statuses = (value ?? "")
		.split(",")
		.map((status) => status.trim())
		.filter(Boolean);
	return statuses.length > 0 ? statuses : null;
}

/** Whether the message still waits in the outbound queue, where only cancelling it is allowed. */
export function isSendPending(status: string): boolean {
	return status === PENDING_SEND_STATUS;
}

/**
 * Whether a queued message is only held back by the undo window rather than scheduled for later: its send
 * time is within the longest window of when it was written, or has already passed.
 */
function isUndoHold(state: Pick<SendState, "scheduledAt">, createdAt: string | Date, now = Date.now()): boolean {
	if (!state.scheduledAt) return true;
	const scheduled = Date.parse(state.scheduledAt);
	return scheduled <= now || scheduled - new Date(createdAt).getTime() <= LONGEST_UNDO_HOLD_MS + 5_000;
}

export type SendStateLabel = { kind: "sending" | "scheduled" | "failed"; text: string };

/** The short text for a row badge: "Sending…", "Scheduled · Oct 30, 9:00 AM" or "Failed to send". */
export function getSendStateLabel(
	state: SendState,
	createdAt: string | Date,
	formatTime: (value: string) => string,
	now = Date.now(),
): SendStateLabel {
	if (state.status === FAILED_SEND_STATUS) return { kind: "failed", text: "Failed to send" };
	if (isUndoHold(state, createdAt, now)) return { kind: "sending", text: "Sending…" };
	return { kind: "scheduled", text: `Scheduled · ${formatTime(state.scheduledAt!)}` };
}
