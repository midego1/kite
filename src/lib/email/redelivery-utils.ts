/**
 * How long a sender's retry is recognised as the same delivery: past the four to five days SMTP servers keep retrying.
 */
export const REDELIVERY_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

/** At most this many stored messages with the same Message-ID are compared, the newest first. */
export const REDELIVERY_CANDIDATES = 5;

/** The raw object metadata field that holds a received message's fingerprint (`redeliveryFingerprint`). */
export const FINGERPRINT_METADATA = "fingerprint";

/** The fingerprint stored for a message without a Date field, which is never taken for a retry. */
export const NO_FINGERPRINT = "none";

/**
 * Spam signals that make an earlier copy suspect: it may be a forged copy sent ahead of the real message, so it never
 * hides a later delivery. Any failed authentication check (a domain without DMARC still fails SPF or DKIM) and the
 * phishing pattern.
 */
export const SUSPECT_SIGNAL_IDS = ["dmarc_failed", "spf_failed", "dkim_failed", "credential_phishing_pattern"] as const;

/** The `LIKE` pattern that finds a signal id in the stored signals JSON (`[{"id":"…",…}]`). */
export function signalIdPattern(id: string): string {
	return `%"id":"${id}"%`;
}

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
 * What a message's fingerprint is the digest of: its own Date and Subject fields and its body's digest, or null when it
 * has no Date. A sender's retry carries the original header block, so these match; a sender that reuses a fixed
 * Message-ID and body (a NAS alert, a cron job) still sends each message with a new Date, so it is never taken for a
 * retry, and one that sends no Date (or a header block that could not be read whole, null) is never compared at all.
 */
export function fingerprintInput(date: string[] | null, subject: string[] | null, bodyDigest: string): string | null {
	if (!date?.length) return null;
	return JSON.stringify([date, subject, bodyDigest]);
}
