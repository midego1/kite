import { getEmailAddress, getEmailAddressList } from "@/lib/email/address";
import type { ImapListedMailbox } from "@/lib/imap/protocol-utils";
import { SmtpDeliveryUnknownError, SmtpMessageTooLargeError, SmtpReplyError } from "@/lib/smtp/errors";

/** How many times one send is handed to the provider when it answers 4xx: the first try and two retries. @public Exercised by the unit tests. */
export const MAX_SUBMIT_ATTEMPTS = 3;

/** Saving the Sent copy at the provider is tried this often before it is given up (spec §7.4). */
export const MAX_APPEND_ATTEMPTS = 3;

/**
 * Shown when the connection failed after the message went out and before the provider said whether it took it
 * (spec §7.3): the provider may have queued it, so Kite never sends it again on its own.
 * @public Exercised by the unit tests.
 */
export const DELIVERY_UNKNOWN_MESSAGE =
	"Delivery unknown: check the recipient or the provider's Sent folder before sending again";

/** The queue message that saves a sent message in the provider's Sent folder. */
export const APPEND_SENT_KIND = "accounts.append_sent";

export type AppendSentMessage = {
	kind: typeof APPEND_SENT_KIND;
	accountId: string;
	messageId: string;
	attempt?: number;
};

export function isAppendSentMessage(payload: unknown): payload is AppendSentMessage {
	if (typeof payload !== "object" || payload === null) return false;
	const value = payload as Record<string, unknown>;
	return value.kind === APPEND_SENT_KIND && typeof value.accountId === "string" && typeof value.messageId === "string";
}

/** What becomes of a send the provider did not take: retried later, or failed with `message`. */
export type SubmitFailure = {
	action: "retry" | "fail";
	message: string;
	/** The account's password no longer works (535, or 5.7.8 at sign-in): the account is set to `auth_failed`. */
	authFailed: boolean;
	/** The message may have been delivered; it must not be sent again automatically. */
	deliveryUnknown: boolean;
};

/**
 * Sorts a failed submission (spec §7.3). Only a 4xx reply (`SmtpReplyError.retryable`) is retried, and only while
 * attempts remain. `SmtpDeliveryUnknownError` is never retried. Anything else (a refusal, a 5xx, a connection that
 * failed before the message went out, a refused size) fails the send with its reason.
 */
export function classifySubmitFailure(error: unknown, attempt: number): SubmitFailure {
	const base = { authFailed: false, deliveryUnknown: false };
	if (error instanceof SmtpDeliveryUnknownError)
		return { ...base, action: "fail", message: DELIVERY_UNKNOWN_MESSAGE, deliveryUnknown: true };
	if (error instanceof SmtpReplyError) {
		if (error.authFailed)
			return {
				...base,
				action: "fail",
				authFailed: true,
				message: `${error.message}. Reconnect the account under Settings → Connected accounts.`,
			};
		return {
			...base,
			action: error.retryable && attempt < MAX_SUBMIT_ATTEMPTS ? "retry" : "fail",
			message: error.message,
		};
	}
	if (error instanceof SmtpMessageTooLargeError) return { ...base, action: "fail", message: error.message };
	const message = error instanceof Error && error.message ? error.message : "Sending through the account failed";
	return { ...base, action: "fail", message: message.slice(0, 300) };
}

/** Seconds before the next try after a 4xx: one minute, then five. */
export function submitRetryDelaySeconds(attempt: number): number {
	return attempt <= 1 ? 60 : 300;
}

/** Seconds before saving the Sent copy again. */
export function appendRetryDelaySeconds(attempt: number): number {
	return attempt <= 1 ? 60 : 600;
}

/** The SMTP envelope of a message: the From address, and every To, Cc and Bcc address (Bcc only here). */
export function submissionEnvelope(message: { from: string; to: string[]; cc?: string[]; bcc?: string[] }) {
	return {
		from: getEmailAddress(message.from),
		recipients: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].flatMap((entry) =>
			getEmailAddressList(entry),
		),
	};
}

/** Where the exact bytes of a message sent through an account are kept (spec §7.3), `raw_r2_key` of its Sent row. */
export function sentRawKey(messageId: string): string {
	return `sent/${messageId}.eml`;
}

/**
 * A safe upper estimate of a message's size once encoded: attachments in base64 lines, bodies at worst
 * quoted-printable, and room for headers and boundaries. Checked against the provider's limit before the send is
 * queued, so nobody waits for an undo window to learn that the message is too large.
 */
export function estimateMimeBytes(
	message: { text?: string | null; html?: string | null },
	attachmentBytes: readonly number[] = [],
): number {
	const utf8 = (value: string | null | undefined) => new TextEncoder().encode(value ?? "").byteLength;
	const body = Math.ceil((utf8(message.text) + utf8(message.html)) * 1.1);
	const attachments = attachmentBytes.reduce((total, size) => total + Math.ceil(size / 3) * 4 * (78 / 76) + 400, 0);
	return Math.ceil(16 * 1024 + body + attachments);
}

/** `25 MB`, in the decimal megabytes the providers name. @public Exercised by the unit tests. */
export function formatMegabytes(bytes: number): string {
	return `${Math.round((bytes / 1_000_000) * 10) / 10} MB`;
}

/** The refusal of a message over the provider's limit, naming the limit. */
export function tooLargeMessage(sizeBytes: number, limitBytes: number, provider: string): string {
	return `The message is about ${formatMegabytes(sizeBytes)}; ${provider} accepts at most ${formatMegabytes(limitBytes)}`;
}

/** Refuses a message the connected account's provider would refuse for its size, before it is queued (spec §7.3). */
export function assertWithinProviderLimit(
	limit: { bytes: number; provider: string } | null | undefined,
	message: Parameters<typeof estimateMimeBytes>[0],
	attachments: readonly { content: { byteLength: number } }[] = [],
): void {
	if (!limit) return;
	const estimate = estimateMimeBytes(
		message,
		attachments.map((attachment) => attachment.content.byteLength),
	);
	if (estimate > limit.bytes) throw new Error(tooLargeMessage(estimate, limit.bytes, limit.provider));
}

const SENT_NAMES = [
	"sent",
	"sent items",
	"sent messages",
	"sent mail",
	"[gmail]/sent mail",
	"inbox.sent",
	"inbox/sent",
];

/** The account's Sent folder: the one marked `\Sent` (RFC 6154), else the first with a usual name, else null. */
export function pickSentFolder(mailboxes: readonly ImapListedMailbox[]): string | null {
	const marked = mailboxes.find((mailbox) => mailbox.attributes.some((value) => value.toLowerCase() === "\\sent"));
	if (marked) return marked.name;
	for (const name of SENT_NAMES) {
		const match = mailboxes.find(
			(mailbox) =>
				mailbox.name.toLowerCase() === name &&
				!mailbox.attributes.some((value) => value.toLowerCase() === "\\noselect"),
		);
		if (match) return match.name;
	}
	return null;
}
