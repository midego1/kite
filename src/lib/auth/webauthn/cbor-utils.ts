/**
 * A minimal CBOR decoder (RFC 8949) for what WebAuthn sends: attestation objects and COSE keys. It reads
 * unsigned and negative integers, byte and text strings, arrays, maps, false, true and null, all with definite
 * lengths, which is the canonical form CTAP2 requires. Anything else (indefinite lengths, tags, floats, undefined,
 * 64-bit values past `Number.MAX_SAFE_INTEGER`, nesting deeper than 16) is refused, never guessed at.
 */

export type CborValue = number | Uint8Array | string | boolean | null | CborValue[] | Map<CborKey, CborValue>;
type CborKey = number | string;

export class CborError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CborError";
	}
}

const MAX_DEPTH = 16;
const MAX_ITEMS = 1024;

/** Decodes the item at `offset` and returns it with the offset just past it. */
export function decodeCborItem(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
	const reader = { bytes, offset };
	const value = readItem(reader, 0);
	return { value, end: reader.offset };
}

/** Decodes a buffer that must hold exactly one item. */
export function decodeCbor(bytes: Uint8Array): CborValue {
	const { value, end } = decodeCborItem(bytes);
	if (end !== bytes.length) throw new CborError("Trailing bytes after CBOR item");
	return value;
}

type Reader = { bytes: Uint8Array; offset: number };

function readByte(reader: Reader): number {
	if (reader.offset >= reader.bytes.length) throw new CborError("Unexpected end of CBOR data");
	return reader.bytes[reader.offset++];
}

function readLength(reader: Reader, info: number): number {
	if (info < 24) return info;
	if (info === 24) return readByte(reader);
	if (info === 25) return (readByte(reader) << 8) | readByte(reader);
	if (info === 26)
		return ((readByte(reader) << 24) >>> 0) + (readByte(reader) << 16) + (readByte(reader) << 8) + readByte(reader);
	if (info === 27) {
		let value = 0;
		for (let index = 0; index < 8; index++) value = value * 256 + readByte(reader);
		if (!Number.isSafeInteger(value)) throw new CborError("CBOR integer too large");
		return value;
	}
	throw new CborError("Indefinite or reserved CBOR length");
}

function readBytes(reader: Reader, length: number): Uint8Array {
	if (reader.offset + length > reader.bytes.length) throw new CborError("Unexpected end of CBOR data");
	const slice = reader.bytes.slice(reader.offset, reader.offset + length);
	reader.offset += length;
	return slice;
}

function readItem(reader: Reader, depth: number): CborValue {
	if (depth > MAX_DEPTH) throw new CborError("CBOR nested too deeply");
	const initial = readByte(reader);
	const major = initial >> 5;
	const info = initial & 0x1f;
	switch (major) {
		case 0:
			return readLength(reader, info);
		case 1:
			return -1 - readLength(reader, info);
		case 2:
			return readBytes(reader, readLength(reader, info));
		case 3:
			return new TextDecoder("utf-8", { fatal: true }).decode(readBytes(reader, readLength(reader, info)));
		case 4: {
			const length = readLength(reader, info);
			if (length > MAX_ITEMS) throw new CborError("CBOR array too long");
			const items: CborValue[] = [];
			for (let index = 0; index < length; index++) items.push(readItem(reader, depth + 1));
			return items;
		}
		case 5: {
			const length = readLength(reader, info);
			if (length > MAX_ITEMS) throw new CborError("CBOR map too long");
			const map = new Map<CborKey, CborValue>();
			for (let index = 0; index < length; index++) {
				const key = readItem(reader, depth + 1);
				if (typeof key !== "number" && typeof key !== "string") throw new CborError("Unsupported CBOR map key");
				if (map.has(key)) throw new CborError("Duplicate CBOR map key");
				map.set(key, readItem(reader, depth + 1));
			}
			return map;
		}
		case 7:
			if (info === 20) return false;
			if (info === 21) return true;
			if (info === 22) return null;
			throw new CborError("Unsupported CBOR simple value");
		default:
			throw new CborError("Unsupported CBOR tag");
	}
}
