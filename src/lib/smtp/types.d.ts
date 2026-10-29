import type { MailSocketSecurity } from "@/lib/net/types";

/** An SMTP submission server and the account that signs in to it. */
export type SmtpLogin = {
	host: string;
	port: number;
	security: MailSocketSecurity;
	username: string;
	password: string;
};

/** One complete reply: the code of its last line and the text of every line. */
export type SmtpReply = {
	code: number;
	/** The RFC 3463 enhanced status code (`5.7.8`) the first line starts with, or null. */
	enhancedCode: string | null;
	/** The text of each line, without the code and its separator. */
	lines: string[];
};

/** The protocol step a reply answered, which names the failure (`smtpFailureMessage`). */
export type SmtpStage = "greeting" | "ehlo" | "starttls" | "auth" | "mail" | "rcpt" | "data";

/** What the server announced in its EHLO answer. */
export type SmtpExtensions = {
	/** Every keyword, upper-case (`STARTTLS`, `PIPELINING`, `8BITMIME`, …). */
	keywords: string[];
	/** The SASL mechanisms of `AUTH` (and the obsolete `AUTH=`), upper-case. */
	auth: string[];
	/** The largest message the server accepts (`SIZE n`); null when it named no limit (or `SIZE 0`). */
	size: number | null;
};

export type SmtpTlsPlan = { action: "none" } | { action: "starttls" } | { action: "refuse"; reason: string };

export type SmtpAuthMethod = "plain" | "login";

/** What one connection accepts from a server, and how long it waits (`smtpLimits`). */
export type SmtpLimits = {
	/** One reply line. */
	lineBytes: number;
	/** The lines of one reply. */
	replyLines: number;
	/** The deadline of one command's reply, and of each chunk of the message written after DATA. */
	commandTimeoutMs: number;
	/** The deadline of the reply to the end of the message, while the server queues it. */
	dataTimeoutMs: number;
};

/** The envelope of one message: the sender for `MAIL FROM` and every To, Cc and Bcc address for `RCPT TO`. */
export type SmtpEnvelope = { from: string; recipients: string[] };
