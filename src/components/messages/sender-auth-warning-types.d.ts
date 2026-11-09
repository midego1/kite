export type SenderAuthConcern =
	"dmarc_failed" | "display_name_spoof" | "spf_failed" | "dkim_failed" | "dkim_unaligned" | "reply_to_mismatch";

export type SenderAuthWarning = {
	/** Most serious first. */
	concerns: SenderAuthConcern[];
	/**
	 * The trusted contact a spoofed display name reuses, when `display_name_spoof` is among the
	 * concerns: the address for the owner and a full-access viewer, `true` for anyone else (a match
	 * was found, but the mailbox owner's contact address is never sent to a delegate who could not
	 * already see it), `null` otherwise.
	 */
	spoofedContact: string | true | null;
};
