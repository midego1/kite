import { MailServerRefusedError } from "@/lib/net/errors";
import type { MailSocket } from "@/lib/net/types";
import {
	getLiteralLength,
	isTaggedCompletion,
	isTaggedOk,
	parseCapabilities,
	parseFetchUid,
	parseGreeting,
} from "./protocol-utils";

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
	/** The latest capabilities the server announced; replaced after STARTTLS and sign-in. */
	capabilities: string[] = [];

	constructor(socket: MailSocket) {
		this.socket = socket;
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
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
		try {
			await secure.opened;
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
		while (true) {
			const line = await this.readLine();
			if (line.startsWith("+") && !sent) {
				sent = true;
				await this.write(`${token}\r\n`);
				continue;
			}
			if (isTaggedCompletion(line, tag)) {
				if (!isTaggedOk(line, tag)) throw new Error(`IMAP sign-in failed: ${line.slice(tag.length + 1)}`);
				this.noteCapabilities(line);
				return;
			}
			this.noteCapabilities(line);
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
		await this.writer.write(this.encoder.encode(value));
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
		const { value, done } = await this.reader.read();
		if (done || !value) throw new Error("IMAP connection closed unexpectedly");
		const unread = this.end - this.start;
		if (this.end + value.byteLength > this.buffer.byteLength) {
			if (unread + value.byteLength <= this.buffer.byteLength / 2) {
				this.buffer.copyWithin(0, this.start, this.end);
			} else {
				let capacity = this.buffer.byteLength;
				while (capacity < (unread + value.byteLength) * 2) capacity *= 2;
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
