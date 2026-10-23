export type AuthResult = "pass" | "fail" | "unknown";

/** A deterministic phishing reason; model reasons are added on top and never remove these. */
export type DeterministicPhishingSignal =
	| "suspicious_verdict"
	| "displayed_link_mismatch"
	| "ip_address_url"
	| "punycode_url"
	| "spf_failed"
	| "dkim_failed"
	| "dmarc_failed"
	| "display_name_spoof"
	| "html_attachment"
	| "attachment_login_form"
	| "attachment_active_content"
	| "risky_attachment"
	| "urlhaus_url"
	| "urlhaus_payload"
	| "threatfox_url"
	| "threatfox_payload"
	| "safelist_pressure";

/** Signs that back up a model's phishing flag; on their own they do not warn. */
export type SupportingPhishingSignal = "url_shortener";

/** A link host and whether it is on the sender's registrable domain. */
export type LinkHostFact = { host: string; sameAsSender: boolean };

/** Computed outside this module (`summarizeLinks` in the spam link utils), which stays free of runtime imports. */
export type LinkFacts = {
	/** The registrable domain of the From address, as in `example.co.uk` for `mail.example.co.uk`. */
	senderDomain: string | null;
	hosts: LinkHostFact[];
};

export type FactsMessage = {
	fromAddr: string;
	subject: string | null;
	textBody: string | null;
	spamVerdict: string | null;
	/** JSON `SpamSignal[]` as stored on `messages.spam_signals`. */
	spamSignals: string | null;
};

export type FactsAttachment = { filename: string; contentType: string; size: number };

export type FactsContact = {
	email: string;
	displayName: string | null;
	source: "manual" | "inbound" | "outbound";
};

export type CollectFactsInput = {
	message: FactsMessage;
	headers?: Record<string, string>;
	attachments?: FactsAttachment[];
	/** Readable body text when the message is HTML only; defaults to `textBody`. */
	bodyText?: string;
	/** The reviewer's contacts used for known-sender and display-name spoofing checks. */
	contacts?: FactsContact[];
	/** The sender's domain, or a parent of it, is a domain of this install. */
	ownDomain?: boolean;
	links?: LinkFacts;
};

export type MessageFacts = {
	senderAddress: string;
	senderName: string | null;
	/** Mailing list, bulk, no-reply or other automatic mail: deterministic facts only, no model call. */
	automatic: boolean;
	bulk: boolean;
	list: boolean;
	noReply: boolean;
	listUnsubscribe: string | null;
	auth: { spf: AuthResult; dkim: AuthResult; dmarc: AuthResult };
	/** DKIM or DMARC passed and nothing failed. Absent Cloudflare signals mean not verified. */
	authPassed: boolean;
	authFailed: boolean;
	spamVerdict: "inbox" | "suspicious" | "spam" | null;
	suspicious: boolean;
	knownContact: boolean;
	/** The address of the known contact whose display name the sender copies. */
	spoofedContact: string | null;
	phishingSignals: DeterministicPhishingSignal[];
	supportingSignals: SupportingPhishingSignal[];
	/** The sender's domain, or a parent of it, is a domain of this install. */
	ownDomain: boolean;
	senderDomain: string | null;
	/** Distinct link hosts in the body, a fact for the model rather than a warning sign. */
	linkHosts: LinkHostFact[];
	inviteAttachments: FactsAttachment[];
	bodyLength: number;
};
