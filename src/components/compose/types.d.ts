export type ComposeDraft = {
	id: string;
	mailboxId: string | null;
	fromAddr: string;
	toAddr: string;
	ccAddr?: string | null;
	bccAddr?: string | null;
	subject: string | null;
	textBody: string | null;
	htmlBody: string | null;
	inReplyTo?: string | null;
	references?: string | null;
	threadId?: string | null;
	/** Files already stored on the draft, e.g. carried over by Forward. */
	attachments?: ComposeStoredAttachment[];
	agent?: { revision: number; origin: "chat" | "auto" | "mcp"; scheduledAt: string | null } | null;
};

export type ComposeStoredAttachment = {
	id: string;
	filename: string;
	size: number;
	type: string;
	disposition: "attachment" | "inline";
};

/** Headers a reply draft carries so the sent message joins its conversation. */
export type ComposeThreading = {
	inReplyTo: string | null;
	references: string | null;
	threadId: string | null;
};

export type DraftResponse = {
	draft?: ComposeDraft;
	error?: string;
};

export type ComposeAttachment = {
	id: string;
	file: File;
};

/** The fields an autosave writes to `/api/drafts`. */
export type ComposeDraftPayload = {
	mailboxId?: string;
	from: string;
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	html: string;
	text: string;
	inReplyTo: string | null;
	references: string | null;
	threadId: string | null;
	/** Write with Kite inserted text; the draft is marked so a reopened draft is never learnt from. */
	aiAssisted?: boolean;
};

/** One autosave: the draft fields, and the composer files to store on the draft with them. */
export type ComposeDraftSnapshot = {
	payload: ComposeDraftPayload;
	attachments: ComposeAttachment[];
	/** False for AI drafts, whose files are stored when they are sent for review. */
	storeAttachments: boolean;
};
