export type PhishingReport = {
	messageId: string;
	/** The address now blocked, or null when the sender was kept (see `notBlocked`). */
	blockedSender: string | null;
	notBlocked: "no_sender" | "trusted_contact" | "own_domain" | null;
};
