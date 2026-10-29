import { UNDO_SEND_SECONDS_OPTIONS } from "@/lib/email/undo-send-utils";

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

/** The longest undo window a user can pick (`UNDO_SEND_SECONDS_OPTIONS`). */
const LONGEST_UNDO_HOLD_MS = Math.max(...UNDO_SEND_SECONDS_OPTIONS) * 1000;

/** Row timestamps are whole seconds, so a hold can read up to a second longer than the window it was given. */
const TIMESTAMP_SLACK_MS = 2_000;

/**
 * How long a send may stay claimed (`sending`) before it counts as stuck. A claimed send is delivered in the
 * same request or queue message that claimed it, and nothing retries it: if that is cut off, it stays claimed.
 */
export const STUCK_SENDING_AFTER_MS = 10 * 60_000;

/** The 409 code of a move refused because the message is still waiting to go out. */
export const SEND_PENDING_MOVE_REFUSED = "SEND_PENDING_MOVE_REFUSED";

export const SEND_PENDING_MOVE_MESSAGE = "A message waiting to be sent can't be moved. Cancel the send first.";

/** The outbound state of a message that has not been sent yet, or failed to be. */
export type SendState = {
	status: typeof PENDING_SEND_STATUS | typeof FAILED_SEND_STATUS;
	/** When the queued message goes out; null for a failed one without a schedule. */
	scheduledAt: string | null;
	/** The outbound job has not been claimed, so Cancel send and Edit still win the race against delivery. */
	cancellable: boolean;
	/** The job is claimed and being delivered right now. */
	inFlight: boolean;
	/** Whole minutes a claimed send has been stuck, once it passed `STUCK_SENDING_AFTER_MS`. */
	stuckMinutes?: number;
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
export function isSendPending(status: string | undefined): boolean {
	return status === PENDING_SEND_STATUS;
}

/** Whether `action` on a message in `status` is refused because the message would still be sent. */
export function isMoveRefusedWhileSending(action: string, status: string): boolean {
	return isSendPending(status) && action !== "read" && action !== "unread";
}

/**
 * Whether a queued message is only held back by the undo window rather than scheduled for later: its send
 * time is within the longest window of when it was written, or has already passed.
 */
function isUndoHold(state: Pick<SendState, "scheduledAt">, createdAt: string | Date, now = Date.now()): boolean {
	if (!state.scheduledAt) return true;
	const scheduled = Date.parse(state.scheduledAt);
	return scheduled <= now || scheduled - new Date(createdAt).getTime() <= LONGEST_UNDO_HOLD_MS + TIMESTAMP_SLACK_MS;
}

export type SendStateLabel = { kind: "sending" | "scheduled" | "failed" | "stuck"; text: string };

/** The short text for a row badge: "Sending…", "Scheduled · Oct 30, 9:00 AM" or "Failed to send". */
export function getSendStateLabel(
	state: SendState,
	createdAt: string | Date,
	formatTime: (value: string) => string,
	now = Date.now(),
): SendStateLabel {
	if (state.status === FAILED_SEND_STATUS) return { kind: "failed", text: "Failed to send" };
	if (state.stuckMinutes !== undefined) {
		const minutes = state.stuckMinutes;
		return { kind: "stuck", text: `Stuck: still sending after ${minutes} ${minutes === 1 ? "minute" : "minutes"}` };
	}
	if (state.inFlight || isUndoHold(state, createdAt, now)) return { kind: "sending", text: "Sending…" };
	return { kind: "scheduled", text: `Scheduled · ${formatTime(state.scheduledAt!)}` };
}
