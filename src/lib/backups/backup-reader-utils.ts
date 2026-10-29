import type { BackupScanEvent, BackupScanMode, BackupSource } from "./restore-types";

export const INVALID_BACKUP_MESSAGE = "The selected file is not a valid Kite backup";

/** Bytes per ranged read: large enough to keep the number of reads low, small enough to keep memory flat. */
const BACKUP_PAGE_SIZE = 2 * 1024 * 1024;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
/** A byte order mark some editors save before the JSON; TextDecoder dropped it when backups were parsed whole. */
const UTF8_BOM = [0xef, 0xbb, 0xbf];

function isWhitespace(byte: number): boolean {
	return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

/** The structural levels the scanner follows; everything deeper is captured whole as one value. */
type Role = "root" | "tables" | "table";
type Expect = "first" | "key" | "colon" | "value" | "next";
type Frame = { role: Role; array: boolean; expect: Expect; key: string | null; name: string | null };
type Target = "key" | "value";
type Capture = {
	target: Target;
	start: number;
	chunks: Uint8Array[];
	depth: number;
	inString: boolean;
	escape: boolean;
	scalar: boolean;
};

const decoder = new TextDecoder();

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0]!;
	const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** JSON.parse of UTF-8 bytes; an unparsable value means the file is not a backup. */
export function parseJsonBytes(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(decoder.decode(bytes));
	} catch {
		throw new Error(INVALID_BACKUP_MESSAGE);
	}
}

/**
 * Splits a backup document into its parts while it arrives in pages, so no
 * step ever holds the whole file. It follows only the outer structure
 * (`{ ...metadata, "tables": { "<name>": [ row, ... ] } }`) and hands every
 * other value over as raw bytes with absolute offsets, which a later pass can
 * read again by range. In "rows" mode the input is one table's array.
 */
export class BackupDocumentScanner {
	private stack: Frame[] = [];
	private capture: Capture | null = null;
	private offset = 0;
	private started = false;
	private done = false;

	constructor(private readonly mode: BackupScanMode = "document") {}

	push(page: Uint8Array): BackupScanEvent[] {
		const events: BackupScanEvent[] = [];
		let index = 0;
		while (index < page.byteLength) {
			if (this.capture) index = this.continueCapture(page, index, events);
			else index = this.structural(page, index, events);
		}
		if (this.capture) this.capture.chunks.push(page.subarray(Math.max(0, this.capture.start - this.offset)));
		this.offset += page.byteLength;
		return events;
	}

	/** Call after the last page: a document that stops early is not a backup. */
	finish(): void {
		if (!this.done || this.capture) throw new Error(INVALID_BACKUP_MESSAGE);
	}

	private continueCapture(page: Uint8Array, index: number, events: BackupScanEvent[]): number {
		const capture = this.capture!;
		for (; index < page.byteLength; index++) {
			const byte = page[index]!;
			if (capture.scalar) {
				if (isWhitespace(byte) || byte === COMMA || byte === CLOSE_ARRAY || byte === CLOSE_OBJECT) {
					this.endCapture(page, index, events);
					return index;
				}
				continue;
			}
			if (capture.inString) {
				if (capture.escape) capture.escape = false;
				else if (byte === BACKSLASH) capture.escape = true;
				else if (byte === QUOTE) {
					capture.inString = false;
					if (capture.depth === 0) {
						this.endCapture(page, index + 1, events);
						return index + 1;
					}
				}
				continue;
			}
			if (byte === QUOTE) capture.inString = true;
			else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) capture.depth++;
			else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
				capture.depth--;
				if (capture.depth === 0) {
					this.endCapture(page, index + 1, events);
					return index + 1;
				}
			}
		}
		return index;
	}

	private startCapture(target: Target, byte: number, absolute: number): void {
		const string = byte === QUOTE;
		const container = byte === OPEN_OBJECT || byte === OPEN_ARRAY;
		if (target === "key" && !string) throw new Error(INVALID_BACKUP_MESSAGE);
		if (!string && !container && (byte === CLOSE_ARRAY || byte === CLOSE_OBJECT || byte === COMMA || byte === COLON))
			throw new Error(INVALID_BACKUP_MESSAGE);
		this.capture = {
			target,
			start: absolute,
			chunks: [],
			depth: container ? 1 : 0,
			inString: string,
			escape: false,
			scalar: !string && !container,
		};
	}

	private endCapture(page: Uint8Array, endIndex: number, events: BackupScanEvent[]): void {
		const capture = this.capture!;
		this.capture = null;
		capture.chunks.push(page.subarray(Math.max(0, capture.start - this.offset), endIndex));
		const raw = concatBytes(capture.chunks);
		const end = this.offset + endIndex;
		const frame = this.stack.at(-1)!;
		if (capture.target === "key") {
			const key = parseJsonBytes(raw);
			if (typeof key !== "string") throw new Error(INVALID_BACKUP_MESSAGE);
			frame.key = key;
			frame.expect = "colon";
			return;
		}
		frame.expect = "next";
		if (frame.role === "root") events.push({ type: "member", key: frame.key!, raw });
		else if (frame.role === "tables") events.push({ type: "tableValue", name: frame.key!, raw });
		else events.push({ type: "row", name: frame.name!, raw, start: capture.start, end });
	}

	private structural(page: Uint8Array, index: number, events: BackupScanEvent[]): number {
		const byte = page[index]!;
		const absolute = this.offset + index;
		if (isWhitespace(byte) || (absolute < 3 && byte === UTF8_BOM[absolute])) return index + 1;
		if (this.done) throw new Error(INVALID_BACKUP_MESSAGE);
		const frame = this.stack.at(-1);
		if (!frame) this.open(byte, absolute, events);
		else if (frame.expect === "first" || frame.expect === "next")
			return this.member(frame, byte, absolute, index, events);
		else if (frame.expect === "key") this.startCapture("key", byte, absolute);
		else if (frame.expect === "colon") {
			if (byte !== COLON) throw new Error(INVALID_BACKUP_MESSAGE);
			frame.expect = "value";
		} else return this.value(frame, byte, absolute, index, events);
		return index + 1;
	}

	/** The document's opening bracket: an object, or an array in "rows" mode. */
	private open(byte: number, absolute: number, events: BackupScanEvent[]): void {
		if (this.started) throw new Error(INVALID_BACKUP_MESSAGE);
		this.started = true;
		const array = this.mode === "rows";
		if (byte !== (array ? OPEN_ARRAY : OPEN_OBJECT)) throw new Error(INVALID_BACKUP_MESSAGE);
		this.stack.push({ role: array ? "table" : "root", array, expect: "first", key: null, name: null });
		if (array) events.push({ type: "tableStart", name: "", start: absolute });
	}

	/** Right after an opening bracket or a value: the closing bracket, a comma, or (first only) the first entry. */
	private member(frame: Frame, byte: number, absolute: number, index: number, events: BackupScanEvent[]): number {
		if (byte === (frame.array ? CLOSE_ARRAY : CLOSE_OBJECT)) {
			this.close(absolute + 1, events);
			return index + 1;
		}
		if (frame.expect === "next") {
			if (byte !== COMMA) throw new Error(INVALID_BACKUP_MESSAGE);
			frame.expect = frame.array ? "value" : "key";
			return index + 1;
		}
		if (frame.array) return this.value(frame, byte, absolute, index, events);
		this.startCapture("key", byte, absolute);
		return index + 1;
	}

	private value(frame: Frame, byte: number, absolute: number, index: number, events: BackupScanEvent[]): number {
		if (frame.role === "root" && frame.key === "tables" && byte === OPEN_OBJECT) {
			frame.expect = "next";
			this.stack.push({ role: "tables", array: false, expect: "first", key: null, name: null });
			return index + 1;
		}
		if (frame.role === "tables" && byte === OPEN_ARRAY) {
			frame.expect = "next";
			this.stack.push({ role: "table", array: true, expect: "first", key: null, name: frame.key });
			events.push({ type: "tableStart", name: frame.key!, start: absolute });
			return index + 1;
		}
		this.startCapture("value", byte, absolute);
		// A scalar's first byte is part of it; containers and strings were opened by it.
		return index + 1;
	}

	private close(end: number, events: BackupScanEvent[]): void {
		const frame = this.stack.pop()!;
		if (frame.role === "table") events.push({ type: "tableEnd", name: frame.name ?? "", end });
		if (!this.stack.length) this.done = true;
	}
}

/** Reads `[start, end)` of a source in ranged pages. */
export async function* readSourcePages(
	source: BackupSource,
	start = 0,
	end = source.size,
	pageSize = source.pageSize ?? BACKUP_PAGE_SIZE,
): AsyncGenerator<Uint8Array> {
	for (let offset = start; offset < end; offset += pageSize) {
		const length = Math.min(pageSize, end - offset);
		const page = await source.read(offset, length);
		if (page.byteLength !== length) throw new Error("The backup file changed or could not be read while restoring");
		yield page;
	}
}

/** A backup already in memory, read the same way as one in object storage. */
export function memoryBackupSource(content: ArrayBuffer | Uint8Array): BackupSource {
	const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
	return {
		size: bytes.byteLength,
		read: async (offset, length) => bytes.subarray(offset, offset + length),
	};
}
