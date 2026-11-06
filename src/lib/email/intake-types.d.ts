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
	/** The SMTP listener saw a private client address, so SPF (and DMARC through SPF) could not be checked. */
	privateClient?: boolean;
	/**
	 * Where to store the raw message; a fresh key when absent. A key the same delivery always derives makes a repeat
	 * idempotent: the object is overwritten and the queue skips a mailbox that already stored from it (`storedFromRaw`).
	 * It must follow `inbound/<ms>-<id>.eml`, which the sweeper relies on, and carry no address.
	 */
	rawR2Key?: string;
};

export type IntakeActions = {
	/** Refuse the message at the edge; the SMTP listener answers 550, the relay tells the Worker to setReject. */
	reject?: (reason: string) => Promise<void> | void;
	/**
	 * Relay the raw message to another address; returns whether it went out. Absent where forwarding is impossible
	 * (Resend, SES): a forward rule without a copy then stores nothing.
	 */
	forward?: (destination: string, headers: Record<string, string>) => Promise<boolean>;
};

export type IntakeResult =
	| { action: "reject"; reason: string }
	| { action: "forward"; forwardedTo: string | null }
	| { action: "store"; rawR2Key: string; forwardedTo: string | null };
