export type SenderAuthConcern =
	"dmarc_failed" | "display_name_spoof" | "spf_failed" | "dkim_failed" | "dkim_unaligned" | "reply_to_mismatch";

export type SenderAuthWarning = {
	/** Most serious first. */
	concerns: SenderAuthConcern[];
	/** The trusted contact a spoofed display name reuses, when `display_name_spoof` is among the concerns. */
	spoofedContact: string | null;
};
