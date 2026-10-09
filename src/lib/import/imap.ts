import type { ImportMessageInput } from "./types";
import type { ImapImportInput } from "./imap-types";
import {
	assertSafeImapHost,
	chunk,
	getLiteralLength,
	isTaggedCompletion,
	parseFetchUid,
	parseListMailboxName,
	parseSearchUids,
	quoteImapString,
	selectImapUidBatch,
} from "./imap-utils";

type CloudflareSocketConnect = (
	address: { hostname: string; port: number },
	options: { secureTransport: "on" | "off"; allowHalfOpen: boolean },
) => Socket;

async function getCloudflareSocketConnect(): Promise<CloudflareSocketConnect> {
	try {
		const moduleName = "cloudflare:sockets";
		const sockets = (await import(
			/* webpackIgnore: true */
			/* @vite-ignore */
			moduleName
		)) as { connect: CloudflareSocketConnect };
		return sockets.connect;
	} catch {
		throw new Error("IMAP import requires the Cloudflare Workers socket runtime");
	}
}

export class ImapConnection {
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

	constructor(socket: Socket) {
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
	}

	async close(): Promise<void> {
		try {
			await this.writer.close();
		} catch {
			// Socket may already be closed by the server.
		}
	}

	async readGreeting(): Promise<void> {
		const line = await this.readLine();
		if (!line.startsWith("* OK")) throw new Error("IMAP server did not send an OK greeting");
	}

	async command(command: string): Promise<string[]> {
		const tag = this.nextTag();
		await this.write(`${tag} ${command}\r\n`);
		const lines: string[] = [];
		while (true) {
			const line = await this.readLine();
			lines.push(line);
			if (isTaggedCompletion(line, tag)) {
				if (!line.toUpperCase().includes(" OK")) {
					throw new Error(`IMAP command failed: ${line}`);
				}
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
				if (!line.toUpperCase().includes(" OK")) {
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

/** Messages fetched per UID FETCH command. */
const FETCH_CHUNK_SIZE = 25;

export type ImapSession = {
	searchUids(): Promise<string[]>;
	fetchMessages(uids: string[]): Promise<Map<string, ArrayBuffer>>;
	close(): Promise<void>;
};

/** Opens a logged-in IMAP connection with `folder` selected. */
export async function openImapSession(
	input: Pick<ImapImportInput, "host" | "port" | "secure" | "username" | "password" | "folder">,
): Promise<ImapSession> {
	assertSafeImapHost(input.host);
	const connect = await getCloudflareSocketConnect();
	const socket = connect(
		{ hostname: input.host, port: input.port },
		{ secureTransport: input.secure ? "on" : "off", allowHalfOpen: false },
	);
	const imap = new ImapConnection(socket);
	try {
		await imap.readGreeting();
		await imap.command(`LOGIN ${quoteImapString(input.username)} ${quoteImapString(input.password)}`);
		await imap.command(`EXAMINE ${quoteImapString(input.folder)}`);
	} catch (error) {
		await imap.close();
		throw error;
	}
	return {
		async searchUids() {
			const lines = await imap.command("UID SEARCH ALL");
			return lines.flatMap(parseSearchUids);
		},
		fetchMessages: (uids) => imap.fetchMessages(uids),
		async close() {
			await imap.command("LOGOUT").catch(() => undefined);
			await imap.close();
		},
	};
}

export type ImapFetchResult = {
	messages: ImportMessageInput[];
	/** Messages in the folder when the batch was fetched. */
	total: number;
	/** Offset for the next batch, or null when no older messages remain. */
	nextOffset: number | null;
};

export async function fetchImapMessages(input: ImapImportInput): Promise<ImapFetchResult> {
	const session = await openImapSession(input);
	try {
		const batch = selectImapUidBatch(await session.searchUids(), input.limit, input.offset);
		const messages: ImportMessageInput[] = [];
		for (const uids of chunk(batch.uids, FETCH_CHUNK_SIZE)) {
			const fetched = await session.fetchMessages(uids);
			for (const uid of uids) {
				const raw = fetched.get(uid);
				if (raw) messages.push({ filename: `${input.folder}-${uid}.eml`, raw });
			}
		}
		return { messages, total: batch.total, nextOffset: batch.nextOffset };
	} finally {
		await session.close();
	}
}

export async function listImapFolders(input: Omit<ImapImportInput, "folder" | "limit" | "offset">): Promise<string[]> {
	assertSafeImapHost(input.host);
	const connect = await getCloudflareSocketConnect();
	const socket = connect(
		{ hostname: input.host, port: input.port },
		{ secureTransport: input.secure ? "on" : "off", allowHalfOpen: false },
	);
	const imap = new ImapConnection(socket);
	try {
		await imap.readGreeting();
		await imap.command(`LOGIN ${quoteImapString(input.username)} ${quoteImapString(input.password)}`);
		const lines = await imap.command('LIST "" "*"');
		await imap.command("LOGOUT").catch(() => undefined);
		return Array.from(new Set(lines.map(parseListMailboxName).filter((name): name is string => !!name)));
	} finally {
		await imap.close();
	}
}
