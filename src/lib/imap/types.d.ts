import type { MailSocketSecurity } from "@/lib/net/types";

export type ImapLogin = {
	host: string;
	port: number;
	security: MailSocketSecurity;
	username: string;
	password: string;
};

export type ImapTlsPlan = { action: "none" } | { action: "starttls" } | { action: "refuse"; reason: string };

export type ImapAuthMethod = "plain-ir" | "plain" | "login";

/** One message of a UID FETCH: its source and the attributes the server reported with it. */
export type ImapFetchedMessage = {
	raw: ArrayBuffer;
	/** System flags and keywords as the server spelled them (`\Seen`, `\Flagged`, `$Forwarded`). */
	flags: string[];
	/** When the server received the message; null when it sent none or one that does not parse. */
	internalDate: Date | null;
	/** RFC822.SIZE, or null. */
	size: number | null;
	/** Gmail's X-GM-LABELS when they were asked for, else null. */
	labels: string[] | null;
};

/** What one connection accepts from a server, and how long it waits (`imapLimits`). */
export type ImapLimits = {
	/** One literal, which is one message. */
	literalBytes: number;
	/** All literals of one UID FETCH. */
	fetchBatchBytes: number;
	/** One response line. */
	lineBytes: number;
	/** The untagged lines one command collects before its tagged answer. */
	commandResponseBytes: number;
	commandResponseLines: number;
	/** The deadline of a command that receives nothing. */
	commandTimeoutMs: number;
	/** Arriving bytes extend the deadline at this rate… */
	minBytesPerSecond: number;
	/** …up to this hard cap per command. */
	commandMaxMs: number;
};
