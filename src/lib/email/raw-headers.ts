export const MAX_RAW_HEADER_BYTES = 64 * 1024;

/** The header block within the first `limit` bytes, and whether it ends there (or the message does). */
function getHeaderBlock(raw: ArrayBuffer, limit = MAX_RAW_HEADER_BYTES): { text: string; complete: boolean } {
	const slice = raw.slice(0, Math.min(raw.byteLength, limit));
	const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
	const headerEnd = text.search(/\r?\n\r?\n/);
	if (headerEnd === -1) return { text, complete: raw.byteLength <= limit };
	return { text: text.slice(0, headerEnd), complete: true };
}

/** The header block of a raw message, unfolded, keyed by lower-case name with every value in order. */
export function parseRawHeaders(raw: ArrayBuffer): Map<string, string[]> {
	return parseHeaderBlock(getHeaderBlock(raw).text);
}

/**
 * Every value of one header field, in order, from a header block read whole (up to 1 MiB), or null
 * when that is uncertain: the block does not end within the limit (a field further down could be
 * missing), or no field was found although the name appears in the block (another parser might
 * read a field there).
 */
export function completeRawHeaderValues(raw: ArrayBuffer, name: string): string[] | null {
	const block = getHeaderBlock(raw, MAX_COMPLETE_HEADER_BYTES);
	if (!block.complete) return null;
	const values = parseHeaderBlock(block.text).get(name.toLowerCase()) ?? [];
	if (values.length === 0 && block.text.toLowerCase().includes(name.toLowerCase())) return null;
	return values;
}

const MAX_COMPLETE_HEADER_BYTES = 1024 * 1024;

function parseHeaderBlock(block: string): Map<string, string[]> {
	const headers = new Map<string, string[]>();
	let currentName: string | null = null;

	for (const line of block.split(/\r?\n/)) {
		if (/^[\t ]/.test(line) && currentName) {
			const values = headers.get(currentName);
			if (values?.length) values[values.length - 1] += ` ${line.trim()}`;
			continue;
		}

		const separator = line.indexOf(":");
		if (separator <= 0) {
			currentName = null;
			continue;
		}

		currentName = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		headers.set(currentName, [...(headers.get(currentName) ?? []), value]);
	}

	return headers;
}

/** The stored raw message's headers (first value of each), or an empty record when it is gone. */
export async function readRawHeaders(env: CloudflareEnv, rawR2Key: string | null): Promise<Record<string, string>> {
	if (!rawR2Key) return {};
	const object = await env.BUCKET.get(rawR2Key, { range: { offset: 0, length: MAX_RAW_HEADER_BYTES } });
	if (!object) return {};
	const headers = parseRawHeaders(await object.arrayBuffer());
	return Object.fromEntries([...headers].map(([name, values]) => [name, values[0] ?? ""]));
}
