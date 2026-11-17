import { crc32 } from "node:zlib";
import type { ZipEntrySource } from "./zip-stream-types";

/**
 * A minimal streaming ZIP writer (server only): STORED entries, since attachments are mostly compressed already, with
 * the CRC-32 and sizes in a data descriptor after each entry so nothing is buffered, then the central directory.
 * `createZipStream` pulls one chunk at a time, so memory stays at one chunk whatever the archive's size, on Workers and
 * on Node. The CRC is `zlib.crc32` (native on both runtimes, which keeps the Worker's CPU time down). Plain ZIP, no
 * ZIP64: an archive whose offsets would pass 4 GiB fails instead of writing a corrupt file.
 *
 * Every entry declares its size up front and its body must deliver exactly that many bytes, or the archive fails: a
 * file cut short in storage never becomes a valid-looking archive with a truncated file, and the whole archive's size is
 * known before it streams (`zipArchiveBytes`, sent as Content-Length). The CRC is still only known after the data, so
 * the entries keep their data descriptor. Readers that use the central directory (Windows, macOS, 7-Zip, Info-ZIP,
 * Python) are fine with that; pure streaming readers such as Java's `ZipInputStream` refuse STORED entries with one.
 * Times are DOS fields in UTC plus an extended-timestamp field ("UT", 0x5455) with the Unix time, which Info-ZIP and
 * 7-Zip prefer and show in the reader's own time zone.
 */

/** Bit 3: CRC and sizes follow the data. Bit 11: the name is UTF-8. */
const ENTRY_FLAGS = 0x0008 | 0x0800;
const VERSION_NEEDED = 20;
const LOCAL_HEADER_BYTES = 30;
const DATA_DESCRIPTOR_BYTES = 16;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
/** The "UT" extra field: tag, length 5, flags (bit 0: modification time) and the Unix time, in both headers. */
const TIMESTAMP_FIELD_BYTES = 9;
const MAX_UINT32 = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

type EntryHeader = { name: Uint8Array; dosTime: number; dosDate: number; extra: Uint8Array };
type CentralEntry = EntryHeader & { crc: number; size: number; offset: number };

/**
 * MS-DOS date and time fields, in UTC so both runtimes write the same bytes; years clamp to 1980-2107.
 * @public Exercised by the unit tests.
 */
export function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
	const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
	return {
		dosTime: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
		dosDate: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
	};
}

function record(length: number, fill: (view: DataView) => void): Uint8Array {
	const bytes = new Uint8Array(length);
	fill(new DataView(bytes.buffer));
	return bytes;
}

/** The extended-timestamp extra field with the Unix modification time, clamped to what 32 bits hold. */
function timestampField(date: Date): Uint8Array {
	const seconds = Math.min(Math.max(Math.floor(date.getTime() / 1000), 0), MAX_UINT32);
	return record(TIMESTAMP_FIELD_BYTES, (view) => {
		view.setUint16(0, 0x5455, true);
		view.setUint16(2, 5, true);
		view.setUint8(4, 1);
		view.setUint32(5, seconds, true);
	});
}

function localHeader(entry: EntryHeader): Uint8Array {
	// CRC-32 and both sizes stay zero: the data descriptor after the data carries them.
	return record(LOCAL_HEADER_BYTES, (view) => {
		view.setUint32(0, 0x04034b50, true);
		view.setUint16(4, VERSION_NEEDED, true);
		view.setUint16(6, ENTRY_FLAGS, true);
		view.setUint16(10, entry.dosTime, true);
		view.setUint16(12, entry.dosDate, true);
		view.setUint16(26, entry.name.byteLength, true);
		view.setUint16(28, entry.extra.byteLength, true);
	});
}

function dataDescriptor(crc: number, size: number): Uint8Array {
	return record(DATA_DESCRIPTOR_BYTES, (view) => {
		view.setUint32(0, 0x08074b50, true);
		view.setUint32(4, crc, true);
		view.setUint32(8, size, true);
		view.setUint32(12, size, true);
	});
}

function centralHeader(entry: CentralEntry): Uint8Array {
	return record(CENTRAL_HEADER_BYTES, (view) => {
		view.setUint32(0, 0x02014b50, true);
		view.setUint16(4, VERSION_NEEDED, true);
		view.setUint16(6, VERSION_NEEDED, true);
		view.setUint16(8, ENTRY_FLAGS, true);
		view.setUint16(12, entry.dosTime, true);
		view.setUint16(14, entry.dosDate, true);
		view.setUint32(16, entry.crc, true);
		view.setUint32(20, entry.size, true);
		view.setUint32(24, entry.size, true);
		view.setUint16(28, entry.name.byteLength, true);
		view.setUint16(30, entry.extra.byteLength, true);
		view.setUint32(42, entry.offset, true);
	});
}

function endRecord(count: number, directorySize: number, directoryOffset: number): Uint8Array {
	return record(END_RECORD_BYTES, (view) => {
		view.setUint32(0, 0x06054b50, true);
		view.setUint16(8, count, true);
		view.setUint16(10, count, true);
		view.setUint32(12, directorySize, true);
		view.setUint32(16, directoryOffset, true);
	});
}

/**
 * The exact size of the archive `createZipStream` writes for files of these names and sizes, or null when it would
 * pass what a plain ZIP can address (4 GiB, 65,535 entries).
 */
export function zipArchiveBytes(entries: readonly { name: string; size: number }[]): number | null {
	if (entries.length > MAX_ENTRIES) return null;
	const encoder = new TextEncoder();
	let total = END_RECORD_BYTES;
	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name).byteLength;
		total +=
			LOCAL_HEADER_BYTES +
			DATA_DESCRIPTOR_BYTES +
			CENTRAL_HEADER_BYTES +
			2 * (nameBytes + TIMESTAMP_FIELD_BYTES) +
			entry.size;
	}
	return total > MAX_UINT32 ? null : total;
}

function checkedOffset(offset: number): number {
	if (offset > MAX_UINT32) throw new Error("The archive is larger than 4 GiB");
	return offset;
}

/** Thrown when a body delivers more or fewer bytes than its entry declared. */
const SIZE_MISMATCH = "A file in the archive is not the size it was stored with";

async function* entryBody(body: ReadableStream<Uint8Array>, expected: number, totals: { crc: number; size: number }) {
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				if (totals.size !== expected) throw new Error(SIZE_MISMATCH);
				return;
			}
			if (!value.byteLength) continue;
			totals.size += value.byteLength;
			if (totals.size > expected) throw new Error(SIZE_MISMATCH);
			totals.crc = crc32(value, totals.crc);
			yield value;
		}
	} finally {
		// Releases the lock; on early teardown it also stops the read from storage.
		await reader.cancel().catch(() => undefined);
	}
}

async function* generateZip(entries: readonly ZipEntrySource[]): AsyncGenerator<Uint8Array> {
	if (entries.length > MAX_ENTRIES) throw new Error("Too many files for one archive");
	const encoder = new TextEncoder();
	const central: CentralEntry[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		if (!name.byteLength || name.byteLength > 0xffff) throw new Error("Invalid file name in archive");
		if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_UINT32)
			throw new Error("Invalid file size in archive");
		const header: EntryHeader = { name, ...toDosDateTime(entry.modified), extra: timestampField(entry.modified) };
		const body = await entry.open();
		yield localHeader(header);
		yield name;
		yield header.extra;
		const totals = { crc: 0, size: 0 };
		yield* entryBody(body, entry.size, totals);
		yield dataDescriptor(totals.crc, totals.size);
		central.push({ ...header, crc: totals.crc, size: totals.size, offset });
		offset = checkedOffset(
			offset + LOCAL_HEADER_BYTES + name.byteLength + header.extra.byteLength + totals.size + DATA_DESCRIPTOR_BYTES,
		);
	}
	const directoryOffset = offset;
	for (const entry of central) {
		yield centralHeader(entry);
		yield entry.name;
		yield entry.extra;
		offset = checkedOffset(offset + CENTRAL_HEADER_BYTES + entry.name.byteLength + entry.extra.byteLength);
	}
	yield endRecord(central.length, offset - directoryOffset, directoryOffset);
}

/**
 * Streams `entries` into a ZIP archive in order, opening each only when the previous one is written. An entry whose
 * `open` throws, whose body fails or whose body is not its declared size errors the stream, so a download is never a
 * silently partial archive.
 */
export function createZipStream(entries: readonly ZipEntrySource[]): ReadableStream<Uint8Array> {
	const iterator = generateZip(entries);
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel() {
			await iterator.return(undefined).catch(() => undefined);
		},
	});
}
