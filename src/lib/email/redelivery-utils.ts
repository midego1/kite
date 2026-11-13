/**
 * How long a sender's retry is recognised as the same delivery: past the four to five days SMTP servers keep retrying.
 */
export const REDELIVERY_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

/** At most this many stored messages with the same Message-ID are compared, the newest first. */
export const REDELIVERY_CANDIDATES = 5;

/** The raw object metadata field that holds a received message's fingerprint (`redeliveryFingerprint`). */
export const FINGERPRINT_METADATA = "fingerprint";

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

/** Lower-case hex of a digest. */
export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * What a message's fingerprint is the digest of: its own Date and Subject fields and its body's digest. A sender's
 * retry carries the original header block, so these match; a sender that reuses a fixed Message-ID and body (a NAS
 * alert, a cron job) still sends each message with a new Date, so it is never taken for a retry. Null stands for a
 * header block that could not be read whole.
 */
export function fingerprintInput(date: string[] | null, subject: string[] | null, bodyDigest: string): string {
	return JSON.stringify([date, subject, bodyDigest]);
}
