import { smtpFailureMessage } from "./protocol-utils";
import type { SmtpReply, SmtpStage } from "./types";

/**
 * The server answered a step with a failure reply. `temporary` (4xx) means the send can be retried later; `authFailed`
 * (535, or the 5.7.8 enhanced code) means the account's credentials no longer work (spec §7.3).
 */
export class SmtpReplyError extends Error {
	readonly stage: SmtpStage;
	readonly code: number;
	readonly enhancedCode: string | null;

	constructor(stage: SmtpStage, reply: SmtpReply, recipient?: string) {
		super(smtpFailureMessage(stage, reply, recipient));
		this.name = "SmtpReplyError";
		this.stage = stage;
		this.code = reply.code;
		this.enhancedCode = reply.enhancedCode;
	}

	get temporary(): boolean {
		return this.code >= 400 && this.code < 500;
	}

	/** A refused reply means the server did not take the message, so a 4xx may be sent again later. */
	get retryable(): boolean {
		return this.temporary;
	}

	get authFailed(): boolean {
		return this.stage === "auth" && (this.code === 535 || this.enhancedCode === "5.7.8");
	}
}

/** The message is larger than the server's announced `SIZE`, so it is refused before anything is sent. */
export class SmtpMessageTooLargeError extends Error {
	readonly limitBytes: number;

	constructor(sizeBytes: number, limitBytes: number) {
		const mb = (bytes: number) => `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;
		super(`The message is ${mb(sizeBytes)}; the SMTP server accepts at most ${mb(limitBytes)}`);
		this.name = "SmtpMessageTooLargeError";
		this.limitBytes = limitBytes;
	}
}

/**
 * The connection failed (timeout, reset, close, a reply that cannot be read) after the first byte of the message went
 * out and before the server's verdict on it arrived. The server may well have queued the message, so this is never
 * temporary and never retryable: sending again could deliver it twice. The caller marks the send as failed with
 * "delivery unknown" instead (spec §7.3).
 */
export class SmtpDeliveryUnknownError extends Error {
	readonly temporary = false;
	readonly retryable = false;

	constructor(reason: string) {
		super(
			`The connection to the SMTP server failed after the message was sent, so it may have been delivered: ${reason}`,
		);
		this.name = "SmtpDeliveryUnknownError";
	}
}
