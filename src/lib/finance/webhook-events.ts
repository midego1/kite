import { createLogger } from "@/lib/logger.mjs";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext, JsonValue } from "@/lib/modules/module-types";
import { webhookSubscription, type SubscriptionRow } from "./record-utils";

const log = createLogger("finance");

const SUBSCRIPTION_DETECTED = "finance.subscription.detected";

/**
 * Tells the owner's webhooks about a subscription that was just added. The context's viewer is the
 * owner, so nobody else's webhooks receive it; a failed delivery never undoes the write.
 */
export async function emitSubscriptionDetected(
	ctx: CapabilityCallContext,
	row: SubscriptionRow,
	source: "suggestion" | "manual",
	messageId: string | null,
): Promise<void> {
	const payload = {
		subscription: webhookSubscription(row),
		source,
		message: messageId ? { kind: "mail:message", id: messageId } : null,
	};
	try {
		await moduleHost.emitWebhook(ctx, "finance", SUBSCRIPTION_DETECTED, payload as unknown as JsonValue);
	} catch (error) {
		log.warn("finance.webhook_failed", { subscriptionId: row.id, error });
	}
}
