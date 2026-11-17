import { and, desc, eq, gte, inArray, isNull, like, ne, notLike, or } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { completeRawHeaderValueLists } from "@/lib/email/raw-headers";
import { normalizeMessageId } from "@/lib/email/thread-lookup";
import {
	FINGERPRINT_METADATA,
	fingerprintInput,
	messageBody,
	NO_FINGERPRINT,
	REDELIVERY_CANDIDATES,
	REDELIVERY_WINDOW_MS,
	signalIdPattern,
	SUSPECT_SIGNAL_IDS,
	toHex,
} from "@/lib/email/redelivery-utils";

const encoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * A received message's fingerprint: the digest of its Date and Subject fields and its body (`fingerprintInput`), or
 * `NO_FINGERPRINT` for a message without a Date. Every hop adds header fields on the way in, so the rest of the header
 * block is left out. Intake stores it in the raw object's metadata (`FINGERPRINT_METADATA`), so a later delivery
 * compares without reading the earlier message.
 */
async function redeliveryFingerprint(raw: ArrayBuffer): Promise<string> {
	const [date, subject] = completeRawHeaderValueLists(raw, ["date", "subject"]);
	if (!date?.length) return NO_FINGERPRINT;
	const input = fingerprintInput(date, subject, await sha256Hex(messageBody(new Uint8Array(raw))));
	return input === null ? NO_FINGERPRINT : sha256Hex(encoder.encode(input));
}

/**
 * The raw object metadata intake stores with a received message: the envelope and the fingerprint
 * (`redeliveryOf` reads all three).
 */
export async function receivedRawMetadata(from: string, to: string, raw: ArrayBuffer): Promise<Record<string, string>> {
	return { from, to, [FINGERPRINT_METADATA]: await redeliveryFingerprint(raw) };
}

/**
 * The message of this mailbox that a delivery repeats, or null. A sender retries a message Kite already stored when an
 * intake hop failed after storing it (the relay timed out while the server finished, an unreadable answer, a proxy
 * error, one recipient of several failing at the SMTP listener), and every attempt gets a raw object of its own. A
 * repeat is the same Message-ID, received through intake in the last `REDELIVERY_WINDOW_MS` from the same envelope
 * sender for the same envelope recipient (the stored raw object's metadata), with the same Date, Subject and body
 * (`redeliveryFingerprint`). Anyone can make up a Message-ID, so a message that only shares one is still delivered,
 * and an earlier copy filed as spam, flagged as phishing or failing DMARC never hides a later one: it may be a forged
 * copy sent ahead of the real message.
 */
export async function redeliveryOf(
	env: CloudflareEnv,
	input: { mailboxId: string; rawR2Key: string; from: string; to: string; raw: ArrayBuffer },
	messageId: string | null,
	now = Date.now(),
): Promise<string | null> {
	const normalized = normalizeMessageId(messageId);
	if (!normalized) return null;
	const candidates = await getDb(env)
		.select({ id: messages.id, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, input.mailboxId),
				inArray(messages.providerMessageId, [normalized, `<${normalized}>`]),
				eq(messages.direction, "inbound"),
				gte(messages.createdAt, new Date(now - REDELIVERY_WINDOW_MS)),
				// Only mail that came in through intake; imports and synced mail are matched elsewhere (`duplicateOf`).
				like(messages.rawR2Key, "inbound/%"),
				ne(messages.rawR2Key, input.rawR2Key),
				ne(messages.status, "spam"),
				or(isNull(messages.spamVerdict), eq(messages.spamVerdict, "inbox")),
				or(
					isNull(messages.spamSignals),
					and(...SUSPECT_SIGNAL_IDS.map((id) => notLike(messages.spamSignals, signalIdPattern(id)))),
				),
			),
		)
		.orderBy(desc(messages.createdAt))
		.limit(REDELIVERY_CANDIDATES);
	let fingerprint: string | null = null;
	for (const candidate of candidates) {
		if (!candidate.rawR2Key) continue;
		const head = await env.BUCKET.head(candidate.rawR2Key);
		const metadata = head?.customMetadata ?? {};
		if (metadata.from !== input.from || metadata.to !== input.to) continue;
		// Raw objects stored before fingerprints were kept are read and fingerprinted here.
		let stored: string | undefined = metadata[FINGERPRINT_METADATA];
		if (stored === NO_FINGERPRINT) continue;
		fingerprint ??= await redeliveryFingerprint(input.raw);
		// A message without a Date is never taken for a retry.
		if (fingerprint === NO_FINGERPRINT) return null;
		if (!stored) {
			const object = await env.BUCKET.get(candidate.rawR2Key);
			if (!object) continue;
			stored = await redeliveryFingerprint(await object.arrayBuffer());
		}
		if (stored === fingerprint) return candidate.id;
	}
	return null;
}
