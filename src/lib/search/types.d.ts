export type ParsedSearchQuery = {
	/** Free text after operators are removed; matched against every indexed column. */
	text: string;
	from?: string;
	/** `from:` with one whole address: the sender is exactly this address (lower case). */
	fromAddress?: string;
	to?: string;
	subject?: string;
	hasAttachment?: boolean;
	read?: "read" | "unread";
	starred?: boolean;
	/** Inclusive lower bound on the message date, from `after:YYYY-MM-DD`. */
	after?: Date;
	/** Exclusive upper bound on the message date, from `before:YYYY-MM-DD`. */
	before?: Date;
	/** `via:` — the connected account mail came through (provider, address, label or domain). */
	via?: string;
	/** True when anything in the query needs the full-text index. */
	needsFullText: boolean;
};

export type SearchToken = { term: string; negate: boolean; phrase: boolean };
