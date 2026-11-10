import { createLogger } from "@/lib/logger.mjs";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext, JsonValue } from "@/lib/modules/module-types";
import type { PaymentFinding } from "./payment-utils";
import { paymentRef } from "./payment-utils";
import { webhookSubscription, type SubscriptionRow } from "./record-utils";

const log = createLogger("finance");

const SUBSCRIPTION_DETECTED = "finance.subscription.detected";
const PAYMENT_RECORDED = "finance.payment.recorded";

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

/**
 * Tells the owner's webhooks about a payment just recorded from new mail by automatic reading (spec §27.3); the
 * historical "Scan last 90 days" never emits it. The context's viewer is the owner, so nobody else's webhooks receive
 * it; a failed delivery never undoes the write.
 */
export async function emitPaymentRecorded(
	ctx: CapabilityCallContext,
	recorded: { id: string; finding: PaymentFinding; messageId: string },
): Promise<void> {
	const { finding } = recorded;
	const payload = {
		payment: {
			ref: paymentRef(recorded.id),
			vendor: finding.vendor,
			docType: finding.docType,
			status: finding.status,
			amount: { minor: finding.amountMinor, currency: finding.currency },
			documentOn: finding.documentOn,
			category: finding.category,
		},
		message: { kind: "mail:message", id: recorded.messageId },
	};
	try {
		// Queued: delivery never runs inside the triage step, whose budget a slow endpoint would eat.
		await moduleHost.emitWebhook(ctx, "finance", PAYMENT_RECORDED, payload as unknown as JsonValue, { queued: true });
	} catch (error) {
		log.warn("finance.webhook_failed", { paymentId: recorded.id, error });
	}
}
