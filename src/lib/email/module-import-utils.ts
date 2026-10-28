import type { ImportMessageInput } from "@/lib/import/types";
import type { HostImportMessage } from "@/lib/modules/host-types";

const BASE64_CHUNK = 0x8000;

/** Raw MIME as the base64 string a host import message carries, so the call stays JSON. */
export function encodeRawMime(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (let index = 0; index < view.length; index += BASE64_CHUNK)
		binary += String.fromCharCode(...view.subarray(index, index + BASE64_CHUNK));
	return btoa(binary);
}

function decodeBase64(value: string): ArrayBuffer {
	const binary = atob(value.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

/** The bytes of one host import message (a byte array, base64 text or UTF-8 text) and the source state it carries. */
export function decodeHostImportMessage(message: HostImportMessage, index: number): ImportMessageInput {
	const filename = message.filename?.trim() || `message-${index + 1}.eml`;
	return { filename, raw: decodeHostRaw(message), ...hostImportState(message) };
}

function decodeHostRaw({ raw, encoding }: HostImportMessage): ArrayBuffer {
	if (Array.isArray(raw)) return new Uint8Array(raw).buffer as ArrayBuffer;
	if (encoding === "base64") return decodeBase64(raw);
	return new TextEncoder().encode(raw).buffer as ArrayBuffer;
}

/** Only real booleans and a parseable time are kept; anything else leaves the default. */
function hostImportState(message: HostImportMessage): Pick<ImportMessageInput, "read" | "starred" | "receivedAt"> {
	const receivedAt = typeof message.receivedAt === "string" ? new Date(message.receivedAt) : null;
	return {
		...(typeof message.read === "boolean" ? { read: message.read } : {}),
		...(typeof message.starred === "boolean" ? { starred: message.starred } : {}),
		...(receivedAt && !Number.isNaN(receivedAt.getTime()) ? { receivedAt } : {}),
	};
}
