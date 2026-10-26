import type { AgentActionProposal } from "./types";

const DESTINATION_NAMES: Record<string, string> = {
	inbox: "the inbox",
	archived: "the archive",
	trash: "trash",
	spam: "spam",
};

function emailCount(proposal: Pick<AgentActionProposal, "emailIds" | "emailId">): string {
	const count = proposal.emailIds?.length ?? (proposal.emailId ? 1 : 0);
	return `${count} ${count === 1 ? "email" : "emails"}`;
}

/** The text of the button that approves a proposal. */
export function approveActionLabel(proposal: AgentActionProposal): string {
	switch (proposal.action) {
		case "discard_draft":
			return "Approve discard";
		case "mark_email_read":
			return proposal.read === false ? "Approve mark as unread" : "Approve mark as read";
		case "mark_emails_read":
			return `Approve mark ${emailCount(proposal)} as read`;
		case "mark_emails_unread":
			return `Approve mark ${emailCount(proposal)} as unread`;
		case "create_folder":
			return `Approve new folder “${proposal.name ?? ""}”`;
		case "move_emails_to_folder":
			return `Approve move to “${proposal.folderName ?? "folder"}”`;
		default:
			return `Approve move to ${DESTINATION_NAMES[proposal.destination ?? ""] ?? proposal.destination}`;
	}
}

/** What an approved action did, in the words the panel shows next to Undo. */
export function approvedActionText(proposal: AgentActionProposal): string {
	switch (proposal.action) {
		case "discard_draft":
			return "Draft discarded.";
		case "mark_email_read":
			return proposal.read === false ? "Marked as unread." : "Marked as read.";
		case "mark_emails_read":
			return `Marked ${emailCount(proposal)} as read.`;
		case "mark_emails_unread":
			return `Marked ${emailCount(proposal)} as unread.`;
		case "create_folder":
			return `Created folder “${proposal.name ?? ""}”.`;
		case "move_emails_to_folder":
			return `Moved ${emailCount(proposal)} to “${proposal.folderName ?? "folder"}”.`;
		default:
			return `Moved ${emailCount(proposal)} to ${DESTINATION_NAMES[proposal.destination ?? ""] ?? proposal.destination}.`;
	}
}

/** Whether the panel offers Undo: the action was approved, recorded and is inside its undo window. */
export function canUndoAction(proposal: AgentActionProposal, now: Date): boolean {
	if (proposal.status !== "approved" || !proposal.actionId || !proposal.undoUntil) return false;
	return new Date(proposal.undoUntil).getTime() > now.getTime();
}

/** What an undone action says: a plain "Undone." unless some emails had moved or changed since and stayed. */
export function undoneActionText(proposal: Pick<AgentActionProposal, "action" | "undo">): string {
	const counts = proposal.undo;
	if (!counts || counts.restored >= counts.total) return "Undone.";
	const left = counts.total - counts.restored;
	const verb = proposal.action.startsWith("mark_") ? "changed" : "moved";
	return `Undid ${counts.restored} of ${counts.total}; ${left} had ${verb} since.`;
}
