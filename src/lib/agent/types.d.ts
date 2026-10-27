import type { SessionUser } from "@/lib/auth/types";

export type EmailToolName =
	| "list_emails"
	| "get_email"
	| "get_thread"
	| "search_emails"
	| "count_emails"
	| "draft_email"
	| "draft_reply"
	| "edit_draft"
	| "review_draft_send"
	| "mark_email_read"
	| "mark_emails_read"
	| "mark_emails_unread"
	| "move_email"
	| "move_emails"
	| "list_folders"
	| "create_folder"
	| "move_emails_to_folder"
	| "discard_draft";

export type AgentDraftEditInput = {
	draftId: string;
	expectedRevision: number;
	from?: string;
	to?: string;
	cc?: string | null;
	bcc?: string | null;
	subject?: string;
	body?: string;
	scheduledAt?: string | null;
	addAttachments?: { sourceEmailId: string; attachmentId: string }[];
	removeAttachmentIds?: string[];
};

export type AgentToolContext = {
	env: CloudflareEnv;
	user: SessionUser;
	mailboxId: string;
	origin: "chat" | "auto" | "mcp";
	timeZone?: string;
	/** Id for the next draft this context creates, chosen up front so an audited action can find it again. */
	draftId?: string;
	/** Id for the folder `create_folder` creates, chosen up front for the same reason. */
	folderId?: string;
	/** Overrides the From/Reply-To address a reply draft goes to (a calendar proposal goes to the ICS organizer). */
	replyTo?: string;
	/** Told the receipt each move to or out of Spam left, so an approved chat action can record it for its undo. */
	onReceipt?: (messageId: string, receiptId: string) => void;
};
