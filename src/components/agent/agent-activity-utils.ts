import type { ActivityAction, ActivityTarget } from "./agent-activity-types";

const ACTION_LABELS: Record<string, string> = {
	dismiss: "Dismissed a suggestion",
	create_draft: "Drafted a reply",
	move: "Moved the message to spam",
	create_event: "Added an event to the calendar",
	delete_event: "Removed an event from the calendar",
	update_event: "Updated a calendar event",
	send_rsvp: "Answered an invitation",
};

const VARIANT_LABELS: Record<string, string> = {
	"send_rsvp:accepted": "Accepted an invitation",
	"send_rsvp:declined": "Declined an invitation",
};

const STATUS_LABELS: Record<ActivityAction["status"], string> = {
	pending: "In progress",
	applied: "Done",
	undone: "Undone",
	blocked: "Blocked",
	failed: "Failed",
};

/** Plain words for the machine reasons stored on actions and skipped jobs. */
const REASON_TEXT: Record<string, string> = {
	user_click: "Chosen by a person",
	undo: "Undo requested",
	draft_guard: "Blocked: the draft mentioned an address or link that is not in the conversation",
	daily_limit: "Paused: daily limit reached",
	spend_cap: "Paused: daily spend cap reached",
	kill_switch: "Skipped: automatic reading is turned off for this install",
	external_provider_not_allowed: "Skipped: the external AI provider is not allowed to read mail automatically",
	paused: "Skipped: Kite is paused for this mailbox",
	rate_limited: "Skipped: rate limited, too many messages at once",
	autonomy_off: "Skipped: automatic reading is off for this mailbox",
	assistant_disabled: "Skipped: the email assistant is turned off",
	source_changed: "Skipped: the message was moved or deleted first",
	reviewer_unavailable: "Skipped: the reviewer can no longer read this mailbox",
	missing_manage: "Blocked: full access is needed",
	missing_send_on_behalf: "Blocked: permission to send is needed",
	action_not_supported: "Blocked: this action is not available",
	variant_not_supported: "Blocked: this option is not available",
	capability_reply_off: "Blocked: reply suggestions are off",
	capability_calendar_off: "Blocked: calendar suggestions are off",
};

const ALLOWED_RULE = /^(off|suggest|act|auto)_allows_/;
const LEVEL_NAMES: Record<string, string> = { off: "Off", suggest: "Suggest", act: "Act", auto: "Full auto" };

export function initiatorLabel(initiator: ActivityAction["initiator"]): string {
	return initiator === "agent" ? "Kite" : "User";
}

export function statusLabel(status: ActivityAction["status"]): string {
	return STATUS_LABELS[status] ?? status;
}

export function actionLabel(row: Pick<ActivityAction, "action" | "variant" | "undoOf">): string {
	const label = VARIANT_LABELS[`${row.action}:${row.variant}`] ?? ACTION_LABELS[row.action] ?? humanize(row.action);
	return row.undoOf ? `Undid: ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

function humanize(code: string): string {
	const words = code.replace(/_/g, " ").trim();
	return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : code;
}

/** A reason in plain words; free-text reasons (error messages) are shown as they are. */
export function reasonText(reason: string | null): string | null {
	if (!reason) return null;
	if (REASON_TEXT[reason]) return REASON_TEXT[reason];
	const allowed = ALLOWED_RULE.exec(reason);
	if (allowed) return `Allowed in ${LEVEL_NAMES[allowed[1]]} mode`;
	return /\s/.test(reason) ? reason : humanize(reason);
}

/**
 * Where a row's link goes: the sent reply once the agent draft was sent (the draft itself is then in
 * trash), the agent draft while it exists, otherwise the message the action was about.
 */
export function actionTarget(
	row: Pick<ActivityAction, "action" | "status" | "messageId" | "after" | "subject">,
): ActivityTarget | null {
	const subject = row.subject || "(No subject)";
	const draftId = row.after?.draftId;
	const sentMessageId = row.after?.sentMessageId;
	if (row.action === "create_draft" && typeof sentMessageId === "string")
		return { href: `/sent/${encodeURIComponent(sentMessageId)}`, label: `Sent reply: ${subject}` };
	if (row.action === "create_draft" && row.status === "applied" && typeof draftId === "string")
		return { href: `/drafts/${encodeURIComponent(draftId)}`, label: `Draft reply: ${subject}` };
	if (!row.messageId) return null;
	const folder = row.action === "move" && row.status === "applied" ? "spam" : "inbox";
	return { href: `/${folder}/${encodeURIComponent(row.messageId)}`, label: subject };
}

/** Rows recording an undo carry no Undo of their own; every other row shows one, enabled or not. */
export function showsUndo(row: Pick<ActivityAction, "undoOf">): boolean {
	return !row.undoOf;
}

/** Why Undo is disabled for a row, or null when it can be clicked. */
export function undoDisabledReason(
	row: Pick<ActivityAction, "status" | "canUndo" | "undoUntil">,
	now: Date,
): string | null {
	if (row.status === "blocked") return "Blocked actions did nothing to undo";
	if (row.status === "undone") return "Already undone";
	if (row.status === "failed") return "Failed actions did nothing to undo";
	if (row.status === "pending") return "Still in progress";
	if (!row.undoUntil || new Date(row.undoUntil).getTime() <= now.getTime()) return "The undo window has passed";
	return row.canUndo ? null : "This action cannot be undone";
}

export function activityUrl(mailboxId: string): string {
	return `/api/agent/actions?mailboxId=${encodeURIComponent(mailboxId)}`;
}

/** The mailbox to show first: the selected one when the user has full access to it, else the first listed. */
export function pickActivityMailbox(
	mailboxes: readonly { id: string }[],
	preferred: string | null | undefined,
): string | null {
	if (preferred && mailboxes.some((mailbox) => mailbox.id === preferred)) return preferred;
	return mailboxes[0]?.id ?? null;
}
