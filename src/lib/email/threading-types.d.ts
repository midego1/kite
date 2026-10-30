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
	/**
	 * Received mail only (upstream Mailflare #223): who sent it, and whether it passed DMARC for its From domain on
	 * the intake hop's trusted `Authentication-Results`. In-Reply-To and References are the sender's to write, so the
	 * message joins a stored parent's conversation only when this sender already takes part in it or DMARC passed,
	 * and a Message-ID that is already a thread's key never seeds into it. Imports, synced mail and JMAP drafts leave
	 * it out: they are the user's own history.
	 */
	sender?: { address: string; dmarcAligned: boolean };
};
