import type { MessageListCursor } from "./cursor-types";

/**
 * Opaque keyset cursor for lists ordered by `created_at DESC, id DESC`. It
 * carries the sort key of the last row on the page, so the next page starts
 * after it without the database walking every skipped row as OFFSET does.
 */
export function encodeMessageCursor(cursor: MessageListCursor): string {
	const seconds = Math.floor(cursor.createdAt.getTime() / 1000);
	return toBase64Url(`${seconds}:${cursor.id}`);
}

export function decodeMessageCursor(value: string | null | undefined): MessageListCursor | null {
	if (!value || value.length > 512) return null;
	let decoded: string;
	try {
		decoded = fromBase64Url(value);
	} catch {
		return null;
	}
	const separator = decoded.indexOf(":");
	if (separator <= 0) return null;
	const secondsText = decoded.slice(0, separator);
	const id = decoded.slice(separator + 1);
	if (!/^-?\d{1,15}$/.test(secondsText) || !id) return null;
	return { createdAt: new Date(Number(secondsText) * 1000), id };
}

/** The cursor for the page after `rows`, or null when this page was the last one. */
export function getNextMessageCursor(rows: readonly { createdAt: Date; id: string }[], limit: number): string | null {
	if (rows.length < limit || rows.length === 0) return null;
	const last = rows[rows.length - 1]!;
	return encodeMessageCursor({ createdAt: last.createdAt, id: last.id });
}

function toBase64Url(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid cursor");
	const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
