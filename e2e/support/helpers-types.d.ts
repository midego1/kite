export type InboundMail = {
	from: string;
	to: string;
	subject: string;
	text?: string;
	html?: string;
	messageId?: string;
	inReplyTo?: string;
	/** Extra header lines, e.g. `List-Id`, `List-Unsubscribe`, `Authentication-Results`. */
	headers?: Record<string, string>;
	/** Sent as base64 parts of a multipart/mixed message. */
	attachments?: InboundAttachment[];
};

export type InboundAttachment = {
	filename: string;
	/** Full Content-Type value, e.g. `text/calendar; method=REQUEST; charset=utf-8`. */
	contentType: string;
	content: string | Buffer;
};

export type StoredMessage = {
	id: string;
	subject: string | null;
	status: string;
	mailboxId: string;
	threadId?: string | null;
	starred?: boolean;
};
