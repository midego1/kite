import { sesAuthenticationResults } from "@/lib/spam/authentication-results-utils";
import type { SignedSnsEnvelope } from "./sns-signature";

export type SnsEnvelope = SignedSnsEnvelope;

export type SesNotification = {
	from: string;
	recipients: string[];
	bucket: string;
	key: string;
	virusFailed: boolean;
	headers: Record<string, string>;
	/** SES's id for the message; its S3 action stores it under the rule's prefix plus this id. */
	messageId: string | null;
	/**
	 * SES's own SPF, DKIM and DMARC verdicts as an `Authentication-Results` value, or null. They count
	 * only once the SNS signature is verified (`src/app/api/inbound/ses/route.ts`).
	 */
	authenticationResults: string | null;
};

type RawNotification = {
	notificationType?: string;
	mail?: {
		messageId?: string;
		source?: string;
		destination?: string[];
		headers?: { name: string; value: string }[];
	};
	receipt?: {
		recipients?: string[];
		virusVerdict?: { status?: string };
		spfVerdict?: { status?: string };
		dkimVerdict?: { status?: string };
		dmarcVerdict?: { status?: string };
		/** Only present when DMARC failed: what the sender's domain publishes (`none`, `quarantine`, `reject`). */
		dmarcPolicy?: string;
		action?: { type?: string; bucketName?: string; objectKey?: string };
	};
};

function receiptAuthenticationResults(parsed: RawNotification): string | null {
	const receipt = parsed.receipt;
	return sesAuthenticationResults(
		{
			spf: receipt?.spfVerdict?.status,
			dkim: receipt?.dkimVerdict?.status,
			dmarc: receipt?.dmarcVerdict?.status,
			dmarcPolicy: receipt?.dmarcPolicy,
		},
		parsed.mail?.source ?? "",
	);
}

/** Reads the JSON an SES S3 receipt action publishes to SNS; null for anything else. */
export function parseSesNotification(message: string): SesNotification | null {
	let parsed: RawNotification;
	try {
		parsed = JSON.parse(message) as RawNotification;
	} catch {
		return null;
	}
	const action = parsed.receipt?.action;
	if (parsed.notificationType !== "Received" || action?.type !== "S3" || !action.bucketName || !action.objectKey)
		return null;
	const recipients = parsed.receipt?.recipients ?? parsed.mail?.destination ?? [];
	return {
		from: parsed.mail?.source ?? "",
		recipients,
		bucket: action.bucketName,
		key: action.objectKey,
		virusFailed: parsed.receipt?.virusVerdict?.status === "FAIL",
		messageId: typeof parsed.mail?.messageId === "string" ? parsed.mail.messageId : null,
		headers: Object.fromEntries(
			(parsed.mail?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]),
		),
		// SES checked the sender when it received the message; the message's own headers never count.
		authenticationResults: receiptAuthenticationResults(parsed),
	};
}

export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}
