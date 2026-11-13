/**
 * The largest inbound queue message Kite sends, as JSON bytes. Cloudflare Queues refuse a message over 128 KB; the rest
 * is margin for the queue's own encoding. The header map is the sender's, so a message with enough header fields would
 * fail the same way on every retry.
 */
const INBOUND_QUEUE_PAYLOAD_LIMIT_BYTES = 120 * 1024;

export const INBOUND_QUEUE_PAYLOAD_TOO_LARGE_REASON = "Message rejected: the message headers are too large to receive.";

const encoder = new TextEncoder();

/** Whether an inbound queue message is too large to send, which no retry would change. */
export function inboundQueuePayloadTooLarge(payload: unknown): boolean {
	return encoder.encode(JSON.stringify(payload)).byteLength > INBOUND_QUEUE_PAYLOAD_LIMIT_BYTES;
}
