export interface NewMessageEvent {
	from: string;
	fromName: string | null;
	mailboxId: string;
	messageId: string;
	subject: string | null;
	type: "new_message";
	/** One-time code the server detected at delivery, or null. */
	oneTimeCode: string | null;
}

/** A transient notice from a module, shown as a toast; `href` is always a same-origin path. */
export interface ModuleNoticeEvent {
	type: "module_notice";
	moduleId: string;
	notice: string;
	title: string;
	body: string | null;
	href: string | null;
}

/** Title, body and code for a browser new-mail notification. */
export interface NewMessageNotificationParts {
	title: string;
	body: string;
	code: string | null;
}

export interface MessageRealtimeState {
	dismissNotification: () => void;
	notification: NewMessageEvent | null;
}

export type RealtimeChannelMessage =
	| { type: "status"; connected: boolean }
	| { type: "status_request" }
	| { type: "notification"; payload: string }
	| { type: "refresh" }
	| { type: "revision_check" };
