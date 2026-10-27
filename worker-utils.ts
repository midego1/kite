import type { InboundQueueMessage } from "./src/lib/email/inbound";
import type { WebhookRetryMessage } from "./src/lib/email/webhooks";
import { MODULE_MANIFESTS } from "./src/lib/modules/registry";

export function isInboundQueueMessage(payload: unknown): payload is InboundQueueMessage {
	return (
		typeof payload === "object" && payload !== null && "rawR2Key" in payload && "from" in payload && "to" in payload
	);
}

export function isWebhookRetryMessage(payload: unknown): payload is WebhookRetryMessage {
	return (
		typeof payload === "object" &&
		payload !== null &&
		(payload as { kind?: unknown }).kind === "webhook.retry" &&
		typeof (payload as { deliveryId?: unknown }).deliveryId === "string"
	);
}

type CoreQueueMessageKind =
	| "inbound"
	| "webhook_retry"
	| "outbound"
	| "agent_draft"
	| "agent_triage"
	| "agent_line_summary"
	| "agent_style_backfill"
	| "mailbox_purge"
	| "backup"
	| "storage_migration"
	| "unknown";

/** Core kinds plus the metric class each module declares for its own queue messages. */
export type QueueMessageKind = CoreQueueMessageKind | (string & {});

const QUEUE_MESSAGE_KINDS: Record<string, QueueMessageKind> = {
	"email.scheduled": "outbound",
	"agent.draft": "agent_draft",
	"agent.triage": "agent_triage",
	"agent.line_summary": "agent_line_summary",
	"agent.style_backfill": "agent_style_backfill",
	"mailbox.purge": "mailbox_purge",
	"backup.run": "backup",
	"storage.migrate": "storage_migration",
	...Object.fromEntries(
		MODULE_MANIFESTS.flatMap((manifest) => manifest.queueMessageTypes.map((entry) => [entry.kind, entry.metricClass])),
	),
};

// Matches the keys storeRawToR2 and intakeIncomingMail write: a timestamp and a nanoid, no addresses.
const RAW_R2_KEY = /^inbound\/\d+-[A-Za-z0-9_-]+\.eml$/;

/**
 * Log context for a failed queue message. Only the message kind and the raw
 * MIME object key are returned, never addresses, headers or other body fields.
 */
export function describeQueueMessage(payload: unknown): { kind: QueueMessageKind; rawR2Key?: string } {
	if (isInboundQueueMessage(payload)) {
		const key = (payload as { rawR2Key?: unknown }).rawR2Key;
		return typeof key === "string" && RAW_R2_KEY.test(key) ? { kind: "inbound", rawR2Key: key } : { kind: "inbound" };
	}
	if (isWebhookRetryMessage(payload)) return { kind: "webhook_retry" };
	const kind = typeof payload === "object" && payload !== null ? (payload as { kind?: unknown }).kind : undefined;
	return {
		kind: typeof kind === "string" && Object.hasOwn(QUEUE_MESSAGE_KINDS, kind) ? QUEUE_MESSAGE_KINDS[kind] : "unknown",
	};
}

/** Analytics Engine fields for one processed queue message: kind and queue name only. */
export function queueMetric(
	payload: unknown,
	queue: string,
	outcome: "ack" | "retry",
	durationMs: number,
	attempts: number,
	version = "",
) {
	return {
		event: "queue",
		service: "kite",
		name: describeQueueMessage(payload).kind,
		detail: queue,
		outcome,
		durationMs,
		attempts,
		version,
	};
}
