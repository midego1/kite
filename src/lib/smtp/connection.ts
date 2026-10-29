import { MailServerRefusedError } from "@/lib/net/errors";
import type { MailSocket } from "@/lib/net/types";
import { SmtpReplyError } from "./errors";
import { buildReply, parseReplyLine, redactSecrets, smtpLimits } from "./protocol-utils";
import type { SmtpLimits, SmtpReply, SmtpStage } from "./types";

export type SmtpConnectionOptions = Partial<SmtpLimits>;

/** The message is written in chunks of this size, each with its own deadline. */
const WRITE_CHUNK_BYTES = 64 * 1024;

/**
 * One SMTP connection: replies (multi-line included), commands one at a time (no pipelining), the STARTTLS upgrade and
 * the message after DATA. Every reply must arrive before its deadline, so a server that trickles a byte at a time or
 * goes silent cannot hold the job; on a timeout the socket is closed.
 */
export class SmtpConnection {
	private socket: MailSocket;
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private decoder = new TextDecoder();
	private encoder = new TextEncoder();
	/** Bytes received but not yet read as lines. Replies are small, so the buffer is simply concatenated. */
	private pending = new Uint8Array(0);
	private readonly limits: SmtpLimits;
	private deadline = 0;

	constructor(socket: MailSocket, options: SmtpConnectionOptions = {}) {
		this.socket = socket;
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
		this.limits = { ...smtpLimits(), ...options };
		this.restartDeadline(this.limits.commandTimeoutMs);
	}

	async close(): Promise<void> {
		try {
			await this.writer.close();
		} catch {
			// The server may have closed the connection already.
		}
		await this.socket.close().catch(() => undefined);
	}

	/** Reads the greeting; anything but 220 is a refusal. */
	async greeting(): Promise<SmtpReply> {
		const reply = await this.readReply();
		if (reply.code !== 220) throw new SmtpReplyError("greeting", reply);
		return reply;
	}

	/**
	 * Sends one command and waits for its reply, which must carry one of `expected`. `secrets` are replaced in the
	 * reply before it can become an error message.
	 */
	async command(
		line: string,
		stage: SmtpStage,
		expected: readonly number[],
		options: { secrets?: readonly string[]; recipient?: string } = {},
	): Promise<SmtpReply> {
		if (/[\r\n]/.test(line)) throw new Error("SMTP commands cannot contain line breaks");
		await this.write(`${line}\r\n`, this.limits.commandTimeoutMs);
		const reply = await this.readReply();
		if (expected.includes(reply.code)) return reply;
		const secrets = options.secrets ?? [];
		throw new SmtpReplyError(
			stage,
			{ ...reply, lines: reply.lines.map((text) => redactSecrets(text, secrets)) },
			options.recipient,
		);
	}

	/**
	 * Sends STARTTLS and upgrades the socket. Bytes that arrived after the server's 220 were sent before the handshake,
	 * so an attacker on the path could have injected them (CVE-2011-0411 style); the connection is refused instead.
	 */
	async startTls(): Promise<void> {
		try {
			await this.command("STARTTLS", "starttls", [220]);
		} catch (error) {
			if (error instanceof SmtpReplyError) throw new MailServerRefusedError(error.message);
			throw error;
		}
		if (this.pending.length) throw new MailServerRefusedError("The SMTP server sent data before the TLS handshake");
		this.reader.releaseLock();
		this.writer.releaseLock();
		const secure = this.socket.startTls();
		this.socket = secure;
		this.reader = secure.readable.getReader();
		this.writer = secure.writable.getWriter();
		this.restartDeadline(this.limits.commandTimeoutMs);
		try {
			await this.beforeDeadline(secure.opened);
		} catch (error) {
			const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
			throw new Error(`The TLS handshake with the SMTP server failed${reason}`);
		}
	}

	/**
	 * Writes the prepared DATA payload (`smtpDataPayload`: dot-stuffed and ending in `.` CRLF) and reads the server's
	 * verdict, which may take longer while it queues the message.
	 */
	async sendData(payload: Uint8Array): Promise<SmtpReply> {
		for (let offset = 0; offset < payload.length; offset += WRITE_CHUNK_BYTES)
			await this.writeBytes(payload.subarray(offset, offset + WRITE_CHUNK_BYTES), this.limits.commandTimeoutMs);
		this.restartDeadline(this.limits.dataTimeoutMs);
		const reply = await this.readReply();
		if (reply.code !== 250) throw new SmtpReplyError("data", reply);
		return reply;
	}

	private async readReply(): Promise<SmtpReply> {
		const lines: { code: number; text: string }[] = [];
		while (true) {
			const line = await this.readLine();
			const parsed = parseReplyLine(line);
			if (!parsed || (lines.length && parsed.code !== lines[0].code))
				throw new Error("The SMTP server sent a reply Kite does not understand");
			lines.push(parsed);
			if (parsed.final) return buildReply(lines);
			if (lines.length >= this.limits.replyLines)
				throw new Error(`The SMTP server sent more than ${this.limits.replyLines} lines in one reply`);
		}
	}

	private async readLine(): Promise<string> {
		let scanFrom = 0;
		while (true) {
			for (let index = scanFrom; index < this.pending.length - 1; index += 1) {
				if (this.pending[index] === 13 && this.pending[index + 1] === 10) {
					const line = this.decoder.decode(this.pending.subarray(0, index));
					this.pending = this.pending.slice(index + 2);
					return line;
				}
			}
			scanFrom = Math.max(this.pending.length - 1, 0);
			if (this.pending.length > this.limits.lineBytes)
				throw new Error(`The SMTP server sent a line longer than ${Math.round(this.limits.lineBytes / 1024)} KB`);
			const { value, done } = await this.beforeDeadline(this.reader.read());
			if (done || !value) throw new Error("SMTP connection closed unexpectedly");
			const next = new Uint8Array(this.pending.length + value.byteLength);
			next.set(this.pending);
			next.set(value, this.pending.length);
			this.pending = next;
		}
	}

	private async write(value: string, timeoutMs: number): Promise<void> {
		await this.writeBytes(this.encoder.encode(value), timeoutMs);
	}

	/** Every write starts (or continues) a command, so it resets the deadline for what follows. */
	private async writeBytes(bytes: Uint8Array, timeoutMs: number): Promise<void> {
		this.restartDeadline(timeoutMs);
		await this.beforeDeadline(this.writer.write(bytes));
	}

	private restartDeadline(timeoutMs: number): void {
		this.deadline = Date.now() + timeoutMs;
	}

	/** Waits for `promise` until the deadline; on a timeout the socket is closed, which settles the pending read or write. */
	private async beforeDeadline<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Set by the timer itself, so a timer that fires a millisecond early still counts as the timeout.
		let timedOut = false;
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => {
					timedOut = true;
					reject(new Error("The SMTP server did not answer in time"));
				},
				Math.max(this.deadline - Date.now(), 0),
			);
		});
		try {
			return await Promise.race([promise, expired]);
		} catch (error) {
			if (timedOut) {
				promise.catch(() => undefined);
				await this.socket.close().catch(() => undefined);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}
