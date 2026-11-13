/**
 * How long a sender's retry is recognised as the same delivery: past the four to five days SMTP servers keep retrying.
 */
export const REDELIVERY_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

/** At most this many stored messages with the same Message-ID are compared byte for byte. */
export const REDELIVERY_CANDIDATES = 5;

/**
 * The body of a raw message: everything after the first empty line, or nothing when there is none. Every hop adds
 * header fields on the way in (Cloudflare's Received, ARC and Authentication-Results, the SMTP listener's trace), so a
 * retried message's header block differs from the first attempt's while its body does not.
 */
export function messageBody(raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	for (let index = 0; index < raw.length - 1; index += 1) {
		if (raw[index] !== 0x0a) continue;
		if (raw[index + 1] === 0x0a) return raw.subarray(index + 2);
		if (raw[index + 1] === 0x0d && raw[index + 2] === 0x0a) return raw.subarray(index + 3);
	}
	return raw.subarray(raw.length);
}

/** Whether two byte arrays hold the same bytes. */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
	return true;
}
