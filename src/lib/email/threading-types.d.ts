export type ResolveThreadInput = {
	mailboxId: string | null;
	/** The message's own Message-ID; seeds a new thread when no parent is stored. */
	messageId: string | null;
	inReplyTo?: string | null;
	references?: string[];
	/**
	 * Imported mail only (spec §4.4, decision 8): with no stored parent, key the thread by the first Message-ID in
	 * References (else In-Reply-To) instead of the message's own, so a reply imported before its parent and the
	 * parent itself still meet. Received mail keeps seeding a thread with its own Message-ID.
	 */
	fallback?: "references-root";
};
