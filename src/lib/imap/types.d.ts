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
