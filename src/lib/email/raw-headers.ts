export const MAX_RAW_HEADER_BYTES = 64 * 1024;

function getHeaderBlock(raw: ArrayBuffer): string {
	const slice = raw.slice(0, Math.min(raw.byteLength, MAX_RAW_HEADER_BYTES));
	const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
	const headerEnd = text.search(/\r?\n\r?\n/);
	return headerEnd === -1 ? text : text.slice(0, headerEnd);
}

/** The header block of a raw message, unfolded, keyed by lower-case name with every value in order. */
export function parseRawHeaders(raw: ArrayBuffer): Map<string, string[]> {
	const headers = new Map<string, string[]>();
	let currentName: string | null = null;

	for (const line of getHeaderBlock(raw).split(/\r?\n/)) {
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
