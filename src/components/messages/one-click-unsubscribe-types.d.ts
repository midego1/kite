export type OneClickRun =
	| { status: "done" }
	| { status: "cancelled" }
	/**
	 * `url` is the sender's own page, which the reader can still open (null when the message names none); `limited`
	 * says the server refused for the rate limit, or because this message was already sent a request.
	 */
	| { status: "failed"; url: string | null; limited: "rate" | "duplicate" | null };
