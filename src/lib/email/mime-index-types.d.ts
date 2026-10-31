/** How a part's body is decoded: `identity` for 7bit, 8bit and binary. Anything else is not indexable. */
export type MimeTransferEncoding = "base64" | "identity";

/** A leaf part of a raw message: where its encoded body sits in the raw bytes, and what its headers say. */
export interface MimePartIndex {
	/** Byte offset of the encoded body in the raw message. */
	bodyOffset: number;
	/** Encoded byte length; the line break before the next delimiter belongs to the delimiter (RFC 2046). */
	bodyLength: number;
	/** Null for quoted-printable, uuencode and any other encoding: those parts are never matched. */
	transferEncoding: MimeTransferEncoding | null;
	/** Lowercased `type/subtype`, `text/plain` when the part has no Content-Type. */
	contentType: string;
	disposition: "attachment" | "inline" | null;
	filename: string | null;
	contentId: string | null;
}

/** A postal-mime attachment matched to the part whose decoded bytes are exactly its content. */
export interface MimeAttachmentMatch {
	attachmentIndex: number;
	part: MimePartIndex;
}

export interface MimeAttachmentMatches {
	matches: MimeAttachmentMatch[];
	/** Attachments no part decodes to; they are stored as objects of their own. */
	unmatched: number[];
}
