export type ImportMailboxResult = {
	imported: number;
	skipped: number;
	errors: string[];
};

export type ImportMessageInput = {
	filename: string;
	raw: ArrayBuffer;
	/** From the source's `\Seen` flag (IMAP); unset for file uploads, which stay unread. Outbound mail is always read. */
	read?: boolean;
	/** From the source's `\Flagged` flag (IMAP); unset means not starred. */
	starred?: boolean;
	/** The source's INTERNALDATE, used as the date when the message has no usable `Date` header. */
	receivedAt?: Date | null;
};
