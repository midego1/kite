import type { MimeTransferEncoding } from "./mime-index-types";

/** A `message_attachments` row without the storage columns of migration 0089 (`ATTACHMENT_ROW_COLUMNS`). */
export interface AttachmentRow {
	id: string;
	messageId: string;
	filename: string;
	contentType: string;
	size: number;
	disposition: "attachment" | "inline";
	contentId: string | null;
	r2Key: string;
	createdAt: Date;
}

/** What opening an attachment needs to know about its row. */
export type AttachmentRef = Pick<AttachmentRow, "id" | "r2Key" | "size" | "contentType">;

/** An attachment's decoded bytes as a stream, `size` bytes long. */
export interface OpenedAttachment {
	body: ReadableStream<Uint8Array>;
	size: number;
	contentType: string;
}

/** A range of an attachment's decoded bytes, in the forms R2 takes. */
export type AttachmentByteRange = { offset: number; length?: number } | { suffix: number };

/** Where a 'raw' row's encoded body sits in its message's raw MIME. */
export interface RawAttachmentLocation {
	rawKey: string;
	offset: number;
	length: number;
	encoding: MimeTransferEncoding;
}
