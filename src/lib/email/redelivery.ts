import { and, eq, gte, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { normalizeMessageId } from "@/lib/email/thread-lookup";
import { messageBody, REDELIVERY_CANDIDATES, REDELIVERY_WINDOW_MS, sameBytes } from "@/lib/email/redelivery-utils";

async function bodyDigest(raw: ArrayBuffer): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", messageBody(new Uint8Array(raw))));
}

/**
 * The message of this mailbox that a delivery repeats, or null. A sender retries a message Kite already stored when an
 * intake hop failed after storing it (the relay timed out while the server finished, an unreadable answer, a proxy
 * error, one recipient of several failing at the SMTP listener), and every attempt gets a raw object of its own. A
 * repeat is the same Message-ID, received in the last `REDELIVERY_WINDOW_MS` from the same envelope sender for the
 * same envelope recipient (the stored raw object's metadata), with the same body bytes. Anyone can make up a
 * Message-ID, so a message that only shares one is still delivered.
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
				ne(messages.rawR2Key, input.rawR2Key),
			),
		)
		.limit(REDELIVERY_CANDIDATES);
	let digest: Uint8Array | null = null;
	for (const candidate of candidates) {
		// Only mail that came in through intake; imports and synced mail are matched elsewhere (`duplicateOf`).
		if (!candidate.rawR2Key?.startsWith("inbound/")) continue;
		const head = await env.BUCKET.head(candidate.rawR2Key);
		if (head?.customMetadata?.from !== input.from || head.customMetadata?.to !== input.to) continue;
		const stored = await env.BUCKET.get(candidate.rawR2Key);
		if (!stored) continue;
		digest ??= await bodyDigest(input.raw);
		if (sameBytes(await bodyDigest(await stored.arrayBuffer()), digest)) return candidate.id;
	}
	return null;
}
