export type AgentSendSnapshot = {
	from: string;
	to: string;
	cc: string | null;
	bcc: string | null;
	subject: string;
	text: string | null;
	html: string | null;
	inReplyTo: string | null;
	references: string | null;
	threadId: string | null;
	mailboxId: string;
	scheduledAt: string | null;
	attachments: { id: string; filename: string; size: number; digest: string }[];
};

/** What a draft card should show for an assistant draft id. */
export type AgentDraftState =
	| { state: "draft" }
	| { state: "sent"; messageId: string | null; subject: string | null; to: string | null }
	| { state: "scheduled"; messageId: string | null; subject: string | null; to: string | null; scheduledAt: string }
	| { state: "sending"; messageId: string | null; subject: string | null; to: string | null }
	| { state: "failed"; messageId: string | null; subject: string | null; to: string | null }
	| { state: "unavailable" };
