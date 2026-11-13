export type UnsubscribeRouteParams = {
	params: Promise<{ messageId: string }>;
};

/** The answer of `POST /api/messages/[messageId]/unsubscribe`. */
export type UnsubscribeRouteResponse = {
	unsubscribed?: boolean;
	error?: string;
	code?: "RATE_LIMITED" | "ONE_CLICK_UNAVAILABLE" | "UNSUBSCRIBE_FAILED";
	/** The link the reader can open instead, when Kite could not unsubscribe for them. */
	url?: string | null;
};
