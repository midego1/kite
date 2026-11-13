/** What the list headers of one raw message say, before anything about the viewer is known. */
export type MailingListHeaders = {
	/** `List-Id` identifier (RFC 2919), lower-case, without angle brackets. */
	listId: string | null;
	/** `List-Id` phrase, decoded and cleaned for display; null when absent or unreadable. */
	listName: string | null;
	/** The link the reader may open: `https`/`http` first, else `mailto:` (same rule as before). */
	unsubscribeUrl: string | null;
	/** The `https` URL an RFC 8058 one-click POST goes to, when `List-Unsubscribe-Post` asks for one. */
	oneClickUrl: string | null;
	/** A `DKIM-Signature` lists both `List-Unsubscribe` and `List-Unsubscribe-Post` in its signed headers (`h=`). */
	dkimCoversUnsubscribe: boolean;
};

/** The mailing-list part of a message detail response, as the reader sees it. */
export type MailingListInfo = {
	id: string | null;
	name: string | null;
	/** Kite can unsubscribe for this viewer with an RFC 8058 POST, without opening anything. */
	oneClick: boolean;
};
