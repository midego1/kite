export type ReviewSnapshot = {
	from: string;
	to: string;
	cc: string | null;
	bcc: string | null;
	subject: string;
	text: string | null;
	html: string | null;
	scheduledAt: string | null;
	attachments: { id: string; filename: string; size: number }[];
};

export type SendReviewProps = {
	approvalId: string;
	snapshot: ReviewSnapshot;
	/** Recipients the user has neither written to nor saved as a contact. */
	unfamiliarRecipients?: string[];
	onClose?: () => void;
	/** Offered when the draft changed after this review: open a new review of the draft as it is now. */
	onReviewAgain?: () => void;
	onSent?: (messageId: string) => void;
};

export type AgentReviewResponse = {
	status: string;
	snapshot: ReviewSnapshot | null;
	stale: boolean;
	unfamiliarRecipients?: string[];
	error?: string;
};

/** A send review the user opened: the approval, the exact snapshot and the recipients to double-check. */
export type OpenedSendReview = { approvalId: string; snapshot: ReviewSnapshot; unfamiliarRecipients: string[] };
