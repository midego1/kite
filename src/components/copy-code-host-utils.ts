/**
 * Clipboard plumbing for one-time codes. `requestCopyCode` is the single entry
 * point (in-app popup, reader chip, the plain-Notification fallback); the
 * CopyCodeHost mounted in Providers does the copy and shows a toast, or a
 * dialog with one more Copy button when the browser refuses an unfocused write.
 */

/** Window event carrying `{ code }`; the service worker message handler reuses it. */
export const COPY_CODE_REQUEST_EVENT = "kite:copy-code";

export type CopyCodeRequest = {
	code: string;
};

/** A service worker or window message asking the page to copy or open mail. */
export type CopyCodeChannelMessage = {
	type?: string;
	code?: string;
	messageId?: string;
};

export function requestCopyCode(code: string): void {
	window.dispatchEvent(new CustomEvent<CopyCodeRequest>(COPY_CODE_REQUEST_EVENT, { detail: { code } }));
}

/** Writes the code to the clipboard; false when the browser refuses (no focus, no permission, insecure context). */
export async function writeCodeToClipboard(code: string): Promise<boolean> {
	try {
		if (typeof navigator === "undefined" || !navigator.clipboard) return false;
		await navigator.clipboard.writeText(code);
		return true;
	} catch {
		return false;
	}
}
