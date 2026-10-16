import type { AttachmentContent } from "@/lib/email/attachment-types";
import type { ParsedEmail } from "@/lib/email/parse";

export type SpamVerdict = "inbox" | "suspicious" | "spam";
/** `phishing` trains like `spam`, with extra weight on the message's fingerprint. */
export type SpamClassification = "spam" | "ham" | "phishing";

export type SpamSignal = {
	id: string;
	score: number;
	reason: string;
	metadata?: Record<string, unknown>;
};

export type SpamAnalysisInput = {
	mailboxId: string;
	userId: string;
	envelopeFrom: string;
	headers?: Record<string, string>;
	message: ParsedEmail;
	intelligenceProvider?: SpamIntelligenceProvider;
};

export type SpamAnalysisResult = {
	score: number;
	verdict: SpamVerdict;
	signals: SpamSignal[];
	contentProbability?: number;
	fingerprint: string;
};

export type ReputationKey = { type: "email" | "domain" | "fingerprint"; key: string };

export type WebPageAttachment = { filename: string; text: string };

export type PreparedSpamContent = {
	visibleText: string;
	/** Link domains in the body; these feed the fingerprint and training tokens. */
	urlDomains: string[];
	/** Links in the body, at most 50. */
	urls: string[];
	webPageAttachments: WebPageAttachment[];
	/** Links inside attached web pages, kept apart so the fingerprint matches the stored message. */
	attachmentUrls: string[];
	attachmentUrlDomains: string[];
};

export type SpamIntelligenceInput = {
	senderDomain: string;
	urlDomains: string[];
	fingerprint: string;
	urls: string[];
	attachmentUrls: string[];
	attachments: readonly AttachmentContent[];
};

export interface SpamIntelligenceProvider {
	check(input: SpamIntelligenceInput): Promise<SpamSignal[]>;
}

export type BayesianResult = {
	probability: number;
	contribution: number;
	trainedMessages: number;
	strongestTokens: Array<{ token: string; probability: number }>;
};
