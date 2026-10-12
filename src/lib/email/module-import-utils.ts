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

/** The bytes of one host import message: a byte array, base64 text or UTF-8 text. */
export function decodeHostImportMessage(message: HostImportMessage, index: number) {
	const { raw } = message;
	const filename = message.filename?.trim() || `message-${index + 1}.eml`;
	if (Array.isArray(raw)) return { filename, raw: new Uint8Array(raw).buffer as ArrayBuffer };
	if (message.encoding === "base64") return { filename, raw: decodeBase64(raw) };
	return { filename, raw: new TextEncoder().encode(raw).buffer as ArrayBuffer };
}
