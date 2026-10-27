import { aiReasonText } from "@/lib/agent/ai-error-utils";
import { splitSkipReasons } from "@/lib/agent/auto-read/module-steps-utils";
import { MODULE_MANIFESTS } from "@/lib/modules/registry";
import type { ActivityAction, ActivityTarget } from "./agent-activity-types";

/** Labels of the actions core owns; each module's manifest adds its own, keyed `type` or `type:variant`. */
const ACTION_LABELS: Record<string, string> = {
	dismiss: "Dismissed a suggestion",
	create_draft: "Drafted a reply",
	move: "Moved the message to spam",
	"move:archived": "Moved to the archive",
	"move:trash": "Moved to trash",
	"move:inbox": "Moved to the inbox",
	"mark_read:read": "Marked as read",
	"mark_read:unread": "Marked as unread",
	set_folder: "Moved to a folder",
	create_folder: "Created a folder",
};

/** Kept whether or not the module is on, so older rows stay readable. */
const MODULE_ACTION_LABELS: Record<string, string> = Object.assign({}, ...MODULE_MANIFESTS.map((m) => m.actionLabels));
const MODULE_REASON_TEXT: Record<string, string> = Object.assign({}, ...MODULE_MANIFESTS.map((m) => m.reasonTexts));

const STATUS_LABELS: Record<ActivityAction["status"], string> = {
	pending: "In progress",
	applied: "Done",
	undone: "Undone",
	blocked: "Blocked",
	failed: "Failed",
};

/** Plain words for the machine reasons stored on actions and skipped jobs. */
const REASON_TEXT: Record<string, string> = {
	...MODULE_REASON_TEXT,
	user_click: "Chosen by a person",
	undo: "Undo requested",
	draft_guard: "Blocked: the draft mentioned an address or link that is not in the conversation",
	daily_limit: "Paused: daily limit reached",
	spend_cap:
		"Paused: daily spend cap reached, or without model prices the automatic reading token allowance. It resets at 00:00 UTC; the primary admin can change both in Admin → Agent.",
	kill_switch: "Skipped: automatic reading is turned off for this install",
	external_provider_not_allowed: "Skipped: the external AI provider is not allowed to read mail automatically",
	paused: "Skipped: Kite is paused for this mailbox",
	rate_limited: "Skipped: rate limited, too many messages at once",
	model_failed: "The AI model did not answer; the message was checked without it",
	model_flag_unconfirmed:
		"No phishing warning: the AI model found the message suspicious, but Kite found no sign of phishing in it",
	model_flag_trusted_sender:
		"No phishing warning: the AI model found the message suspicious, but the sender is trusted and Kite found no sign of phishing in it",
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

export function actionLabel(
	row: Pick<ActivityAction, "action" | "variant" | "undoOf"> & { after?: ActivityAction["after"] },
): string {
	const label =
		MODULE_ACTION_LABELS[`${row.action}:${row.variant}`] ??
		ACTION_LABELS[`${row.action}:${row.variant}`] ??
		ACTION_LABELS[row.action] ??
		MODULE_ACTION_LABELS[row.action] ??
		humanize(row.action);
	const full = `${label}${batchDetail(row.after ?? null)}`;
	return row.undoOf ? `Undid: ${full.charAt(0).toLowerCase()}${full.slice(1)}` : full;
}

/** A chat action's folder name and, for more than one email, how many it changed. */
function batchDetail(after: ActivityAction["after"]): string {
	const folder = typeof after?.folderName === "string" ? ` “${after.folderName}”` : "";
	const count = typeof after?.count === "number" && after.count > 1 ? ` (${after.count} emails)` : "";
	return `${folder}${count}`;
}

const MOVE_FOLDERS = new Set(["archived", "trash", "spam"]);

/** The list a moved message sits in after the row: spam for a phishing "Mark as spam", else the destination. */
function movedFolder(row: Pick<ActivityAction, "action" | "status" | "variant">): string {
	if (row.action !== "move" || row.status !== "applied") return "inbox";
	return MOVE_FOLDERS.has(row.variant) ? row.variant : row.variant === "inbox" ? "inbox" : "spam";
}

function humanize(code: string): string {
	const words = code.replace(/_/g, " ").trim();
	return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : code;
}

/** A reason in plain words; free-text reasons (error messages) are shown as they are. */
export function reasonText(reason: string | null): string | null {
	if (!reason) return null;
	const known = (part: string) => REASON_TEXT[part] ?? aiReasonText(part);
	if (known(reason)) return known(reason);
	const parts = splitSkipReasons(reason);
	if (parts.length > 1 && parts.every(known)) return parts.map(known).join(", ");
	const allowed = ALLOWED_RULE.exec(reason);
	if (allowed) return `Allowed in ${LEVEL_NAMES[allowed[1]]} mode`;
	return /\s/.test(reason) ? reason : humanize(reason);
}

/**
 * Where a row's link goes: the sent reply once the agent draft was sent (the draft itself is then in
 * trash), the agent draft while this viewer can open it, otherwise the message the action was about.
 * A calendar action carries the record ref the server resolved (a link, or plain text when unavailable).
 */
export function actionTarget(
	row: Pick<
		ActivityAction,
		"action" | "variant" | "status" | "messageId" | "after" | "subject" | "draftAvailable" | "target"
	>,
): ActivityTarget | null {
	if (row.target) return row.target;
	const subject = row.subject || "(No subject)";
	const draftId = row.after?.draftId;
	const sentMessageId = row.after?.sentMessageId;
	if (row.action === "create_draft" && typeof sentMessageId === "string")
		return { href: `/sent/${encodeURIComponent(sentMessageId)}`, label: `Sent reply: ${subject}` };
	if (row.action === "create_draft" && row.status === "applied" && row.draftAvailable && typeof draftId === "string")
		return { href: `/drafts/${encodeURIComponent(draftId)}`, label: `Draft reply: ${subject}` };
	const folderId = typeof row.after?.folderId === "string" ? row.after.folderId : null;
	if (row.action === "create_folder")
		return folderId && row.status === "applied"
			? { href: `/folders/${encodeURIComponent(folderId)}`, label: "Open folder" }
			: null;
	if (!row.messageId) return null;
	if (row.action === "set_folder" && row.status === "applied" && folderId)
		return { href: `/folders/${encodeURIComponent(folderId)}/${encodeURIComponent(row.messageId)}`, label: subject };
	return { href: `/${movedFolder(row)}/${encodeURIComponent(row.messageId)}`, label: subject };
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
