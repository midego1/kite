export type IntakeInput = {
	/** Envelope sender. */
	from: string;
	/** Envelope recipient (one message per recipient). */
	to: string;
	raw: ArrayBuffer;
	/** Lower-cased header names to values, as the Worker handler receives them. */
	headers: Record<string, string>;
	/**
	 * The `Authentication-Results` value the hop that handed us the message verified it with, or
	 * null. Never taken from `headers` or `raw`: those are whatever the sender wrote.
	 */
	authenticationResults?: string | null;
};

export type IntakeActions = {
	/** Refuse the message at the edge; the SMTP listener answers 550, the relay tells the Worker to setReject. */
	reject?: (reason: string) => Promise<void> | void;
	/** Relay the raw message to another address; returns whether it went out. */
	forward?: (destination: string, headers: Record<string, string>) => Promise<boolean>;
};

export type IntakeResult =
	| { action: "reject"; reason: string }
	| { action: "forward"; forwardedTo: string | null }
	| { action: "store"; rawR2Key: string; forwardedTo: string | null };
