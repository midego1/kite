import type { InboundQueueMessage } from "@/lib/email/inbound";

/**
 * Sends a stored message to the inbound queue. When the send fails the raw object is deleted before the error is
 * rethrown: the sender retries the whole message and every attempt stores a new one, so a failed attempt must not leave
 * up to 25 MiB behind for the sweeper.
 */
export async function enqueueOrDiscard(env: CloudflareEnv, payload: InboundQueueMessage): Promise<void> {
	try {
		await env.INBOUND_QUEUE.send(payload);
	} catch (error) {
		await env.BUCKET.delete(payload.rawR2Key).catch((cleanup: unknown) =>
			console.error(`Raw cleanup failed for ${payload.rawR2Key}`, cleanup),
		);
		throw error;
	}
}
