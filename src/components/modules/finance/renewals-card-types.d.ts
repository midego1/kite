/** One subscription of the command center's Money Watch card. */
export type RenewalLine = {
	id: string;
	/** "Today", "Tomorrow" or the day, or "Failed" for a payment that failed. */
	when: string;
	what: string;
	/** The price, "Trial ends" or "Payment failed". */
	meta: string;
	urgent: boolean;
	href: string;
};

export type RenewalLines = {
	lines: RenewalLine[];
	/** Rows due this week beyond the lines shown. */
	more: number;
};
