import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";

export type PrintHeaderRow = { label: string; value: string };

export type PrintHeaderInput = {
	from: string | null | undefined;
	to: string | null | undefined;
	cc?: string | null;
	bcc?: string | null;
	/** Already formatted in the user's time zone. */
	date: string;
};

/** One message as it is printed or saved as PDF. */
export type PrintMessage = {
	id: string;
	subject: string;
	headers: PrintHeaderRow[];
	/** Attachment names with their sizes as the reader shows them ("12 KB"). */
	attachments: { filename: string; size: string }[];
	/** The body sanitized by the reader's sanitizer, quoted history included; null for a text-only message. */
	html: string | null;
	/** The body as plain text, for text-only mail and the PDF. */
	text: string;
};

export type PrintDocumentInput = {
	title: string;
	messages: PrintMessage[];
};

/** What the reader prints: the fields of a stored message plus its body and attachments. */
export type PrintSource = {
	id: string;
	subject: string | null;
	fromAddr: string;
	toAddr: string | null;
	ccAddr?: string | null;
	bccAddr?: string | null;
	createdAt: string;
	snippet?: string | null;
	textBody?: string | null;
	htmlBody?: string | null;
	attachments?: MessageAttachment[];
	/** Remote images are blocked unless the user always loads them or showed them for this message. */
	blockRemoteImages: boolean;
};

export type PrintScope = "message" | "conversation";
