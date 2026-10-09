export type InboundMail = {
	from: string;
	to: string;
	subject: string;
	text?: string;
	html?: string;
	messageId?: string;
	inReplyTo?: string;
};

export type StoredMessage = {
	id: string;
	subject: string | null;
	status: string;
	mailboxId: string;
	threadId?: string | null;
	starred?: boolean;
};
