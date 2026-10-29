import type { AwsConfig } from "@/lib/aws/aws-types";

export type SendingProvider = "none" | "cloudflare" | "resend" | "ses";

/** A send through a connected account's own SMTP server (spec §7.3): which account, for whom, and which message. */
export type SmtpSubmissionConfig = {
	provider: "smtp";
	accountId: string;
	userId: string;
	/** Kite's id of the message, which names its Message-ID and its stored raw MIME. */
	messageId: string;
	/** 1 for the first try; a 4xx is tried again while attempts remain. */
	attempt: number;
};

export type OutboundProviderConfig =
	| { provider: "cloudflare" }
	| { provider: "resend"; apiKey: string }
	| { provider: "ses"; config: AwsConfig }
	| SmtpSubmissionConfig;

/** What a provider returns: the Message-ID replies will carry; a send through an account also its stored raw MIME. */
export type OutboundProviderResult = { messageId: string; rawR2Key?: string; appendSent?: boolean };

export type OutboundProviderAttachment = {
	filename: string;
	type: string;
	content: ArrayBuffer;
	disposition: "attachment" | "inline";
	contentId?: string | null;
};

export type OutboundProviderMessage = {
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	attachments?: OutboundProviderAttachment[];
};

export type ResendKeyStatus = {
	configured: boolean;
	/** Where the key in use comes from; the key itself never leaves the server. */
	source: "settings" | "environment" | null;
};
