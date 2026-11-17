/**
 * The largest inbound queue message Kite sends, as JSON bytes. Cloudflare Queues refuse a message over 128 KB; the rest
 * is margin for the queue's own encoding. The header map is the sender's, so a message with enough header fields would
 * fail the same way on every retry.
 */
const INBOUND_QUEUE_PAYLOAD_LIMIT_BYTES = 120 * 1024;

export const INBOUND_QUEUE_PAYLOAD_TOO_LARGE_REASON = "Message rejected: the message headers are too large to receive.";

const encoder = new TextEncoder();

/**
 * Whether an inbound queue message is too large to send, which no retry would change. Measured conservatively: the
 * queue may store a string holding any character above U+00FF as UTF-16, two bytes per character, so the larger of that
 * and its UTF-8 size counts.
 */
export function inboundQueuePayloadTooLarge(payload: unknown): boolean {
	const json = JSON.stringify(payload);
	let wide = json.length;
	for (let index = 0; index < json.length; index += 1) {
		if (json.charCodeAt(index) > 0xff) {
			wide = json.length * 2;
			break;
		}
	}
	return Math.max(wide, encoder.encode(json).byteLength) > INBOUND_QUEUE_PAYLOAD_LIMIT_BYTES;
}
