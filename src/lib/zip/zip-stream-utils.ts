import { crc32 } from "node:zlib";
import type { ZipEntrySource } from "./zip-stream-types";

/**
 * A minimal streaming ZIP writer (server only): STORED entries, since attachments are mostly compressed already, with
 * the CRC-32 and sizes in a data descriptor after each entry so nothing is buffered, then the central directory.
 * `createZipStream` pulls one chunk at a time, so memory stays at one chunk whatever the archive's size, on Workers and
 * on Node. The CRC is `zlib.crc32` (native on both runtimes, which keeps the Worker's CPU time down). Plain ZIP, no
 * ZIP64: an archive whose offsets would pass 4 GiB fails instead of writing a corrupt file.
 */

/** Bit 3: CRC and sizes follow the data. Bit 11: the name is UTF-8. */
const ENTRY_FLAGS = 0x0008 | 0x0800;
const VERSION_NEEDED = 20;
const LOCAL_HEADER_BYTES = 30;
const DATA_DESCRIPTOR_BYTES = 16;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const MAX_UINT32 = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

type CentralEntry = { name: Uint8Array; crc: number; size: number; offset: number; dosTime: number; dosDate: number };

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

function localHeader(name: Uint8Array, dosTime: number, dosDate: number): Uint8Array {
	// CRC-32 and both sizes stay zero: the data descriptor after the data carries them.
	return record(LOCAL_HEADER_BYTES, (view) => {
		view.setUint32(0, 0x04034b50, true);
		view.setUint16(4, VERSION_NEEDED, true);
		view.setUint16(6, ENTRY_FLAGS, true);
		view.setUint16(10, dosTime, true);
		view.setUint16(12, dosDate, true);
		view.setUint16(26, name.byteLength, true);
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
		total += LOCAL_HEADER_BYTES + DATA_DESCRIPTOR_BYTES + CENTRAL_HEADER_BYTES + 2 * nameBytes + entry.size;
	}
	return total > MAX_UINT32 ? null : total;
}

function checkedOffset(offset: number): number {
	if (offset > MAX_UINT32) throw new Error("The archive is larger than 4 GiB");
	return offset;
}

async function* entryBody(body: ReadableStream<Uint8Array>, totals: { crc: number; size: number }) {
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (!value.byteLength) continue;
			totals.crc = crc32(value, totals.crc);
			totals.size += value.byteLength;
			checkedOffset(totals.size);
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
		const { dosTime, dosDate } = toDosDateTime(entry.modified);
		const body = await entry.open();
		yield localHeader(name, dosTime, dosDate);
		yield name;
		const totals = { crc: 0, size: 0 };
		yield* entryBody(body, totals);
		yield dataDescriptor(totals.crc, totals.size);
		central.push({ name, crc: totals.crc, size: totals.size, offset, dosTime, dosDate });
		offset = checkedOffset(offset + LOCAL_HEADER_BYTES + name.byteLength + totals.size + DATA_DESCRIPTOR_BYTES);
	}
	const directoryOffset = offset;
	for (const entry of central) {
		yield centralHeader(entry);
		yield entry.name;
		offset = checkedOffset(offset + CENTRAL_HEADER_BYTES + entry.name.byteLength);
	}
	yield endRecord(central.length, offset - directoryOffset, directoryOffset);
}

/**
 * Streams `entries` into a ZIP archive in order, opening each only when the previous one is written. An entry whose
 * `open` throws, or whose body fails, errors the stream, so a download is never a silently partial archive.
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
