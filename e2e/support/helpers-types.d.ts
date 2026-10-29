export type InboundMail = {
	from: string;
	to: string;
	subject: string;
	/** `null` with `html` sends an HTML-only message, without a text/plain part. */
	text?: string | null;
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
	/** Defaults to `attachment`. */
	disposition?: "inline" | "attachment";
	/** Sent as a `Content-ID` header, which a cid: reference in the HTML points at. */
	contentId?: string;
};

export type StoredMessage = {
	id: string;
	subject: string | null;
	status: string;
	mailboxId: string;
	threadId?: string | null;
	starred?: boolean;
};

/** One row of `GET /api/backups`, as the admin Backups page reads it. */
export type BackupRow = {
	id: string;
	status: "queued" | "running" | "completed" | "failed";
	trigger: string;
	error: string | null;
	filename: string | null;
	objectsStatus?: "copying" | "completed" | "failed" | "restoring" | null;
	objectsCount?: number | null;
};

/** The latest restore as `GET /api/backups/health` reports it. */
export type RestoreSummary = { id: string; status: string; active: boolean; error: string | null };
