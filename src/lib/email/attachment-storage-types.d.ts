import type { MimeTransferEncoding } from "./mime-index-types";

/** A `message_attachments` row without the storage columns of migration 0088 (`ATTACHMENT_ROW_COLUMNS`). */
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
	/** Hex SHA-256 of the decoded bytes, checked when they are read into memory; null on rows written without it. */
	sha256?: string | null;
}

/** Where a verified attachment's encoded body sits in the raw message being stored. */
export type RawPartLocation = Omit<RawAttachmentLocation, "rawKey">;

/** What a delete may remove once its rows are gone (`deleteUnreferencedObjects`). */
export interface ObjectDeletionCandidates {
	/** Attachment rows' `r2Key`s; an object goes only when no remaining row names it, and `raw:` sentinels are skipped. */
	attachmentKeys?: readonly string[];
	/** Messages' `raw_r2_key`s; a raw message goes only when no remaining message names it. */
	rawKeys?: readonly (string | null)[];
	/** Keys only the deleted messages owned (offloaded HTML bodies), removed without a check. */
	ownedKeys?: readonly string[];
}

/** The candidate keys that remaining rows still name. */
export interface ReferencedObjectKeys {
	attachmentKeys: string[];
	rawKeys: string[];
}

/** A row that names another row's object instead of writing one (`shareAttachmentObject`). */
export interface SharedAttachmentRow {
	id: string;
	messageId: string;
	filename: string;
	contentType: string;
	disposition: "attachment" | "inline";
	contentId: string | null;
}

/** How attachments are stored (`GET /api/admin/attachment-storage`). */
export interface AttachmentStorageCounts {
	/** Rows with an object; `keys` objects behind them, `storedBytes` their size counted once per object. */
	objects: { rows: number; keys: number; bytes: number; storedBytes: number };
	/** Rows served from a range of their raw message, with no object of their own. */
	raw: { rows: number; bytes: number };
}

/** Referenced object keys looked up in storage, and the ones that were not there. */
export interface AttachmentObjectsVerification {
	checked: number;
	missing: { key: string; messageIds: string[] }[];
}

/** What the lazy repair needs to know about a row and its message. */
export interface RepairableAttachment {
	id: string;
	messageId: string;
	filename: string;
	contentType: string;
	size: number;
	contentId: string | null;
	r2Key: string;
	rawKey: string | null;
	status: string;
	/** The digest recorded for the row's bytes, when it has one (null before migration 0088). */
	sha256: string | null;
}
