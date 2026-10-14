export interface NewMessageNotification {
	from: string;
	fromName: string | null;
	mailboxId: string;
	messageId: string;
	subject: string | null;
	type: "new_message";
	/** One-time code detected at delivery; transient, never persisted in a column. */
	oneTimeCode?: string;
}

export interface AgentDraftNotification {
	mailboxId: string;
	draftId: string;
	type: "agent_draft";
}

/** A suggestion was created, updated or closed; sent only to users with full access on the mailbox. */
export interface AgentSuggestionNotification {
	mailboxId: string;
	messageId: string;
	suggestionId: string;
	kind: string;
	type: "agent_suggestion";
}

/** A transient notice a module sends one user; `href` is always a same-origin path. */
export interface ModuleNoticeNotification {
	moduleId: string;
	notice: string;
	title: string;
	body: string | null;
	href: string | null;
	type: "module_notice";
}

export type RealtimePayload =
	NewMessageNotification | AgentDraftNotification | AgentSuggestionNotification | ModuleNoticeNotification;

export interface MailboxRevisionRow {
	mailbox_id: string;
	revision: number;
	permission: string;
}

export interface RevisionPing {
	type: "ping";
	revision: string | null;
}

export interface RevisionNotification {
	type: "revision";
	revision: string;
	changed: boolean;
}

export interface RealtimeNotificationRequest {
	userIds: string[];
	payload: RealtimePayload;
}
