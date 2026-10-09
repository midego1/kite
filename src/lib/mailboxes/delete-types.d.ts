export type MailboxPurgeMessage = {
	kind: "mailbox.purge";
	mailboxId: string;
	/** Set when the mailbox goes because its domain is being removed. */
	domainId?: string;
};

export type MailboxDeletionResult = {
	/** False when messages are still being removed in the background. */
	completed: boolean;
	deletedMessages: number;
};
