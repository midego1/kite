import { MailServerRefusedError } from "@/lib/net/errors";
import type { MailSocket } from "@/lib/net/types";
import {
	getLiteralLength,
	imapLimits,
	imapLoginArgument,
	isTaggedCompletion,
	isTaggedOk,
	parseCapabilities,
	parseFetchAttributes,
	parseGreeting,
} from "./protocol-utils";
import type { ImapFetchedMessage, ImapLimits } from "./types";

export type ImapConnectionOptions = Partial<ImapLimits>;

const MB = 1024 * 1024;

/** One IMAP connection: tagged commands, literals, capabilities and the STARTTLS upgrade. */
export class ImapConnection {
	private socket: MailSocket;
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private decoder = new TextDecoder();
	private encoder = new TextEncoder();
	// Growable receive buffer: unread bytes live in buffer[start, end). Appending
	// doubles capacity instead of copying the whole buffer on every chunk, which
	// kept large messages (attachments) from becoming quadratic.
	private buffer = new Uint8Array(64 * 1024);
	private start = 0;
	private end = 0;
	private scanFrom = 0;
	private tagCounter = 0;
	private readonly limits: ImapLimits;
	/** When the current command (or the greeting) started, and how many bytes have arrived for it since. */
	private commandStart = Date.now();
	private received = 0;
	/** The latest capabilities the server announced; replaced after STARTTLS and sign-in. */
	capabilities: string[] = [];

	constructor(socket: MailSocket, options: ImapConnectionOptions = {}) {
		this.socket = socket;
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
		// Without a runtime the stricter Workers limits apply.
		this.limits = { ...imapLimits(undefined), ...options };
	}

	async close(): Promise<void> {
		try {
			await this.writer.close();
		} catch {
			// Socket may already be closed by the server.
		}
		await this.socket.close().catch(() => undefined);
	}

	/** Reads the greeting; true when the server says PREAUTH (already signed in). */
	async readGreeting(): Promise<boolean> {
		const line = await this.readLine();
		const greeting = parseGreeting(line);
		if (!greeting) throw new Error("IMAP server did not send an OK greeting");
		this.noteCapabilities(line);
		return greeting === "preauth";
	}

	async capability(): Promise<string[]> {
		this.capabilities = [];
		await this.command("CAPABILITY");
		return this.capabilities;
	}

	/**
	 * Sends STARTTLS and upgrades the socket. Bytes that arrived after the server's OK were sent before the
	 * handshake, so an attacker on the path could have injected them; the connection is refused instead.
	 */
	async startTls(): Promise<void> {
		try {
			await this.command("STARTTLS");
		} catch {
			throw new MailServerRefusedError("The IMAP server refused to start TLS");
		}
		if (this.end > this.start) throw new MailServerRefusedError("The IMAP server sent data before the TLS handshake");
		this.reader.releaseLock();
		this.writer.releaseLock();
		const secure = this.socket.startTls();
		this.socket = secure;
		this.reader = secure.readable.getReader();
		this.writer = secure.writable.getWriter();
		this.restartDeadline();
		try {
			await this.beforeDeadline(secure.opened);
		} catch (error) {
			const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
			throw new Error(`The TLS handshake with the IMAP server failed${reason}`);
		}
		// Capabilities announced before the upgrade are not trustworthy (RFC 9051 §6.2.1).
		this.capabilities = [];
	}

	/**
	 * `AUTHENTICATE PLAIN` without `SASL-IR`: the server answers with a continuation, then gets the token. The token
	 * is never part of an error message.
	 */
	async authenticatePlain(token: string, initialResponse: boolean): Promise<void> {
		if (initialResponse) {
			await this.command(`AUTHENTICATE PLAIN ${token}`, "IMAP sign-in failed");
			return;
		}
		const tag = this.nextTag();
		await this.write(`${tag} AUTHENTICATE PLAIN\r\n`);
		let sent = false;
		let cancelled = false;
		while (true) {
			const line = await this.readLine();
			if (line.startsWith("+") && !cancelled) {
				// PLAIN is one response. A second challenge is cancelled (RFC 9051 §6.2.2), never answered again.
				if (sent) cancelled = true;
				sent = true;
				await this.write(cancelled ? "*\r\n" : `${token}\r\n`);
				continue;
			}
			if (isTaggedCompletion(line, tag)) {
				if (cancelled) throw new Error("IMAP sign-in failed: the server asked for more than one response");
				if (!isTaggedOk(line, tag)) throw new Error(`IMAP sign-in failed: ${line.slice(tag.length + 1)}`);
				this.noteCapabilities(line);
				return;
			}
			this.noteCapabilities(line);
		}
	}

	/**
	 * `LOGIN` with each value as a quoted string, or as a synchronizing literal when it is not printable ASCII
	 * (a non-ASCII password), so no value can break the command line. Errors never echo the values.
	 */
	async login(username: string, password: string): Promise<void> {
		const tag = this.nextTag();
		const values = [username, password].map((value) => imapLoginArgument(value));
		let pending = `${tag} LOGIN`;
		for (const value of values) {
			if (value.kind === "quoted") {
				pending += ` ${value.text}`;
				continue;
			}
			await this.write(`${pending} {${value.bytes.byteLength}}\r\n`);
			await this.awaitContinuation(tag);
			await this.writeBytes(value.bytes);
			pending = "";
		}
		await this.write(`${pending}\r\n`);
		while (true) {
			const line = await this.readLine();
			this.noteCapabilities(line);
			if (isTaggedCompletion(line, tag)) {
				if (!isTaggedOk(line, tag)) throw new Error(`IMAP sign-in failed: ${line.slice(tag.length + 1)}`);
				return;
			}
		}
	}

	/** Waits for the `+` that lets a synchronizing literal follow; a tagged answer instead ends the command. */
	private async awaitContinuation(tag: string): Promise<void> {
		while (true) {
			const line = await this.readLine();
			if (line.startsWith("+")) return;
			if (isTaggedCompletion(line, tag)) throw new Error(`IMAP sign-in failed: ${line.slice(tag.length + 1)}`);
		}
	}

	/** Runs a tagged command and returns its lines. `failure` replaces the echoed command in the error. */
	async command(command: string, failure = "IMAP command failed"): Promise<string[]> {
		const tag = this.nextTag();
		await this.write(`${tag} ${command}\r\n`);
		const lines: string[] = [];
		let bytes = 0;
		while (true) {
			const line = await this.readLine();
			lines.push(line);
			// The lines are kept until the command ends, so their total is capped, not only each line.
			bytes += line.length + 2;
			if (bytes > this.limits.commandResponseBytes)
				throw new Error(
					`The IMAP server sent more than ${Math.round(this.limits.commandResponseBytes / MB)} MB in answer to one command`,
				);
			if (lines.length > this.limits.commandResponseLines)
				throw new Error(
					`The IMAP server sent more than ${this.limits.commandResponseLines} lines in answer to one command`,
				);
			this.noteCapabilities(line);
			if (isTaggedCompletion(line, tag)) {
				if (!isTaggedOk(line, tag)) throw new Error(`${failure}: ${line.slice(tag.length + 1)}`);
				return lines;
			}
		}
	}

	/**
	 * Fetches several messages with a single UID FETCH round trip, with their flags, INTERNALDATE and size.
	 * BODY.PEEK[] returns the full RFC 822 source without setting \Seen on the source server. A server may put
	 * the attributes before or after the literal, so the text of the whole response is read before it is parsed.
	 */
	async fetchMessages(uids: string[]): Promise<Map<string, ImapFetchedMessage>> {
		const result = new Map<string, ImapFetchedMessage>();
		if (uids.length === 0) return result;
		const tag = this.nextTag();
		await this.write(`${tag} UID FETCH ${uids.join(",")} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])\r\n`);
		let response: { text: string; raw: ArrayBuffer | null } | null = null;
		let batchBytes = 0;

		while (true) {
			const line = await this.readLine();
			if (isTaggedCompletion(line, tag)) {
				if (!isTaggedOk(line, tag)) throw new Error(`IMAP fetch failed: ${line}`);
				return result;
			}
			if (!response || line.startsWith("* ")) response = { text: line, raw: null };
			else response.text += ` ${line}`;
			const literalLength = getLiteralLength(line);
			if (literalLength === null) {
				// A line without a literal ends the response.
				addFetchedMessage(result, response);
				response = null;
				continue;
			}
			batchBytes += literalLength;
			this.assertLiteralFits(literalLength, batchBytes);
			const bytes = await this.readBytes(literalLength);
			// BODY[] is the only literal asked for; keep the first one.
			response.raw ??= bytes;
		}
	}

	async fetchMessage(uid: string): Promise<ArrayBuffer> {
		const fetched = (await this.fetchMessages([uid])).get(uid);
		if (!fetched) throw new Error("IMAP fetch returned no message");
		return fetched.raw;
	}

	private assertLiteralFits(length: number, batchBytes: number): void {
		if (length > this.limits.literalBytes)
			throw new Error(`The IMAP server sent a message larger than ${Math.round(this.limits.literalBytes / MB)} MB`);
		if (batchBytes > this.limits.fetchBatchBytes)
			throw new Error(`The IMAP server sent more than ${Math.round(this.limits.fetchBatchBytes / MB)} MB in one fetch`);
	}

	private noteCapabilities(line: string): void {
		const announced = parseCapabilities(line);
		if (announced) this.capabilities = announced;
	}

	private nextTag(): string {
		this.tagCounter += 1;
		return `A${String(this.tagCounter).padStart(4, "0")}`;
	}

	private async write(value: string): Promise<void> {
		await this.writeBytes(this.encoder.encode(value));
	}

	/** Every write starts (or continues) a command, so it resets the deadline for the answer. */
	private async writeBytes(bytes: Uint8Array): Promise<void> {
		this.restartDeadline();
		await this.beforeDeadline(this.writer.write(bytes));
	}

	private restartDeadline(): void {
		this.commandStart = Date.now();
		this.received = 0;
	}

	/**
	 * The current command's deadline: `commandTimeoutMs`, plus time earned by the bytes that arrived at
	 * `minBytesPerSecond`, never past `commandMaxMs`. A slow but steady link finishes a large FETCH; a server that
	 * trickles a byte at a time earns next to nothing and still times out.
	 */
	private get deadline(): number {
		const earned = (this.received / this.limits.minBytesPerSecond) * 1000;
		const allowed = Math.min(
			this.limits.commandTimeoutMs + earned,
			Math.max(this.limits.commandMaxMs, this.limits.commandTimeoutMs),
		);
		return this.commandStart + allowed;
	}

	/**
	 * Waits for `promise` until the command deadline. On a timeout the socket is closed, which also settles the
	 * pending read or write, so a server that sends one byte at a time or nothing at all cannot hold the job.
	 */
	private async beforeDeadline<T>(promise: Promise<T>): Promise<T> {
		const remaining = this.deadline - Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Set by the timer itself: a timer may fire a millisecond before `Date.now()` reaches the deadline, so the
		// clock must not be asked again whether this was the timeout.
		let timedOut = false;
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => {
					timedOut = true;
					reject(new Error("The IMAP server did not answer in time"));
				},
				Math.max(remaining, 0),
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

	private async readLine(): Promise<string> {
		while (true) {
			for (let index = Math.max(this.scanFrom, this.start); index < this.end - 1; index += 1) {
				if (this.buffer[index] === 13 && this.buffer[index + 1] === 10) {
					const line = this.decoder.decode(this.buffer.subarray(this.start, index));
					this.start = index + 2;
					this.scanFrom = this.start;
					return line;
				}
			}
			this.scanFrom = Math.max(this.start, this.end - 1);
			if (this.end - this.start > this.limits.lineBytes)
				throw new Error(`The IMAP server sent a line longer than ${Math.round(this.limits.lineBytes / MB)} MB`);
			await this.readMore();
		}
	}

	/**
	 * Reads a literal into a buffer of exactly its length: what is already buffered first, then chunks straight from
	 * the socket, so a large message costs its own size once instead of a doubled receive buffer plus a copy.
	 */
	private async readBytes(length: number): Promise<ArrayBuffer> {
		const out = new Uint8Array(length);
		let filled = Math.min(this.end - this.start, length);
		out.set(this.buffer.subarray(this.start, this.start + filled));
		this.start += filled;
		if (this.start === this.end) this.start = this.end = 0;
		this.scanFrom = this.start;
		while (filled < length) {
			const value = await this.readChunk();
			const take = Math.min(value.byteLength, length - filled);
			out.set(value.subarray(0, take), filled);
			filled += take;
			if (take < value.byteLength) this.append(value.subarray(take));
		}
		return out.buffer;
	}

	private async readChunk(): Promise<Uint8Array> {
		const { value, done } = await this.beforeDeadline(this.reader.read());
		if (done || !value) throw new Error("IMAP connection closed unexpectedly");
		this.received += value.byteLength;
		return value;
	}

	private async readMore(): Promise<void> {
		this.append(await this.readChunk());
	}

	private append(value: Uint8Array): void {
		const unread = this.end - this.start;
		if (this.end + value.byteLength > this.buffer.byteLength) {
			if (unread + value.byteLength <= this.buffer.byteLength / 2) {
				this.buffer.copyWithin(0, this.start, this.end);
			} else {
				let capacity = this.buffer.byteLength;
				while (capacity < unread + value.byteLength) capacity *= 2;
				const next = new Uint8Array(capacity);
				next.set(this.buffer.subarray(this.start, this.end));
				this.buffer = next;
			}
			this.scanFrom -= this.start;
			this.start = 0;
			this.end = unread;
		}
		this.buffer.set(value, this.end);
		this.end += value.byteLength;
	}
}

/** Adds a finished FETCH response that carried a UID and a body; flag-only responses are ignored. */
function addFetchedMessage(
	result: Map<string, ImapFetchedMessage>,
	response: { text: string; raw: ArrayBuffer | null },
): void {
	if (!response.raw) return;
	const { uid, flags, internalDate, size } = parseFetchAttributes(response.text);
	if (uid) result.set(uid, { raw: response.raw, flags, internalDate, size });
}
