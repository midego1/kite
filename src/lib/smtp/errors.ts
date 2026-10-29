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
