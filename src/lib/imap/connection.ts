import { MailServerRefusedError } from "@/lib/net/errors";
import type { MailSocket } from "@/lib/net/types";
import {
	getLiteralLength,
	imapLoginArgument,
	isTaggedCompletion,
	isTaggedOk,
	parseCapabilities,
	parseFetchUid,
	parseGreeting,
} from "./protocol-utils";

/** The largest single literal (one message) the client accepts. */
const MAX_LITERAL_BYTES = 64 * 1024 * 1024;
/** The longest response line, so a server that never sends CRLF cannot fill memory. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** The most message bytes one UID FETCH may return in total. */
const MAX_FETCH_BATCH_BYTES = 96 * 1024 * 1024;
/** How long one command (or the greeting, or the TLS handshake) may take, however slowly the bytes trickle in. */
const COMMAND_TIMEOUT_MS = 180_000;

export type ImapConnectionOptions = { commandTimeoutMs?: number; maxFetchBatchBytes?: number };

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
	private readonly commandTimeoutMs: number;
	private readonly maxFetchBatchBytes: number;
	/** When the current command must have finished; set by every write and by the greeting. */
	private deadline: number;
	/** The latest capabilities the server announced; replaced after STARTTLS and sign-in. */
	capabilities: string[] = [];

	constructor(socket: MailSocket, options: ImapConnectionOptions = {}) {
		this.socket = socket;
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
		this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
		this.maxFetchBatchBytes = options.maxFetchBatchBytes ?? MAX_FETCH_BATCH_BYTES;
		this.deadline = Date.now() + this.commandTimeoutMs;
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
		this.deadline = Date.now() + this.commandTimeoutMs;
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
		while (true) {
			const line = await this.readLine();
			lines.push(line);
			this.noteCapabilities(line);
			if (isTaggedCompletion(line, tag)) {
				if (!isTaggedOk(line, tag)) throw new Error(`${failure}: ${line.slice(tag.length + 1)}`);
				return lines;
			}
		}
	}

	/**
	 * Fetches several messages with a single UID FETCH round trip. BODY.PEEK[]
	 * returns the full RFC 822 source without setting \Seen on the source server.
	 */
	async fetchMessages(uids: string[]): Promise<Map<string, ArrayBuffer>> {
		const result = new Map<string, ArrayBuffer>();
		if (uids.length === 0) return result;
		const tag = this.nextTag();
		await this.write(`${tag} UID FETCH ${uids.join(",")} (UID BODY.PEEK[])\r\n`);
		let pendingRaw: ArrayBuffer | null = null;
		let pendingUid: string | null = null;
		let batchBytes = 0;

		while (true) {
			const line = await this.readLine();
			if (isTaggedCompletion(line, tag)) {
				if (!isTaggedOk(line, tag)) {
					throw new Error(`IMAP fetch failed: ${line}`);
				}
				return result;
			}
			const lineUid = parseFetchUid(line);
			const literalLength = getLiteralLength(line);
			if (line.startsWith("* ")) {
				// A new FETCH response starts; the UID may sit before or after the literal.
				pendingUid = lineUid;
				pendingRaw = null;
			} else if (lineUid && !pendingUid) {
				pendingUid = lineUid;
			}
			if (literalLength !== null) {
				if (literalLength > MAX_LITERAL_BYTES)
					throw new Error(`The IMAP server sent a message larger than ${MAX_LITERAL_BYTES / MB} MB`);
				batchBytes += literalLength;
				if (batchBytes > this.maxFetchBatchBytes)
					throw new Error(`The IMAP server sent more than ${Math.round(this.maxFetchBatchBytes / MB)} MB in one fetch`);
				pendingRaw = await this.readBytes(literalLength);
			}
			if (pendingUid && pendingRaw) {
				result.set(pendingUid, pendingRaw);
				pendingUid = null;
				pendingRaw = null;
			}
		}
	}

	async fetchMessage(uid: string): Promise<ArrayBuffer> {
		const raw = (await this.fetchMessages([uid])).get(uid);
		if (!raw) throw new Error("IMAP fetch returned no message");
		return raw;
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
		this.deadline = Date.now() + this.commandTimeoutMs;
		await this.beforeDeadline(this.writer.write(bytes));
	}

	/**
	 * Waits for `promise` until the command deadline. On a timeout the socket is closed, which also settles the
	 * pending read or write, so a server that sends one byte at a time or nothing at all cannot hold the job.
	 */
	private async beforeDeadline<T>(promise: Promise<T>): Promise<T> {
		const remaining = this.deadline - Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("The IMAP server did not answer in time")), Math.max(remaining, 0));
		});
		try {
			return await Promise.race([promise, expired]);
		} catch (error) {
			if (Date.now() >= this.deadline) {
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
			if (this.end - this.start > MAX_LINE_BYTES)
				throw new Error(`The IMAP server sent a line longer than ${MAX_LINE_BYTES / MB} MB`);
			await this.readMore();
		}
	}

	private async readBytes(length: number): Promise<ArrayBuffer> {
		while (this.end - this.start < length) {
			await this.readMore();
		}
		const bytes = this.buffer.slice(this.start, this.start + length);
		this.start += length;
		this.scanFrom = this.start;
		return bytes.buffer as ArrayBuffer;
	}

	private async readMore(): Promise<void> {
		const { value, done } = await this.beforeDeadline(this.reader.read());
		if (done || !value) throw new Error("IMAP connection closed unexpectedly");
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
