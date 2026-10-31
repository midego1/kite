/** Attachment bytes from the forms a request body or postal-mime hands over. Pure, so the parser needs no storage code. */

export function decodeBase64Content(content: string): ArrayBuffer {
	const binary = atob(content.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
}

export function normalizeAttachmentContent(
	content: ArrayBuffer | Uint8Array | string,
	encoding?: "base64" | "utf8",
): ArrayBuffer {
	if (content instanceof ArrayBuffer) return content;
	if (content instanceof Uint8Array) {
		return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
	}
	if (encoding === "base64") return decodeBase64Content(content);
	return new TextEncoder().encode(content).buffer;
}
