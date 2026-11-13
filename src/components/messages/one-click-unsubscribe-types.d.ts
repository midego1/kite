export type OneClickRun =
	| { status: "done" }
	| { status: "cancelled" }
	/** `url` is the sender's own page, which the reader can still open; null when the message names none. */
	| { status: "failed"; url: string | null; rateLimited: boolean };
