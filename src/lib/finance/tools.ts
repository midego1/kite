import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext, CapabilityHandler } from "@/lib/modules/module-types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { dayInTimeZone } from "./date-utils";
import { MIGRATION_PENDING_ERROR, refusalOf } from "./errors";
import { ledgerEntry, type ChargeRow, type SubscriptionRow } from "./record-utils";
import { ownerDocuments, ownerRows } from "./subscriptions";
import { currencyTotals } from "./totals-utils";
import { selectToolRows, toolSubscription, toolTotals, type ToolInput } from "./tool-utils";

/**
 * The rows and documents the caller may see. In the chat (`moduleHost.mail.aiHidden`, checked now) a subscription is
 * left out, with all its documents, when anything in it came from a mailbox with AI off: the mailbox it was found in,
 * its source or latest message, any document's message, or a card from such a mailbox that updated it. A mixed row is left
 * out whole, because which fields that card changed is not recorded.
 */
async function visibleToCaller(ctx: CapabilityCallContext, rows: SubscriptionRow[], documents: ChargeRow[]) {
	const hidden = await moduleHost.mail.aiHidden(
		ctx,
		rows.map((row) => ({
			mailboxIds: [row.mailboxId],
			messageIds: [
				row.sourceMessageId,
				row.lastMessageId,
				...documents.filter((document) => document.subscriptionId === row.id).map((document) => document.messageId),
			],
			refs: [{ kind: "finance:subscription", id: row.id }],
		})),
	);
	const kept = rows.filter((_, index) => !hidden[index]);
	const ids = new Set(kept.map((row) => row.id));
	return { rows: kept, documents: documents.filter((document) => ids.has(document.subscriptionId)) };
}

/**
 * `list_subscriptions`: the viewer's own subscriptions the input asks for, and the totals over all of
 * them, including what was paid in the last 12 months. Read-only; before migration 0063 it lists nothing.
 */
export const listSubscriptionsTool: CapabilityHandler = async (input, ctx) => {
	if (!ctx.viewer) throw new Error("list_subscriptions needs a viewer");
	const today = dayInTimeZone(new Date().toISOString(), normalizeTimeZone(ctx.timeZone));
	try {
		const { rows, documents } = await visibleToCaller(
			ctx,
			...(await Promise.all([ownerRows(ctx.viewer.userId), ownerDocuments(ctx.viewer.userId)])),
		);
		return {
			subscriptions: selectToolRows(rows, input as ToolInput, today).map(toolSubscription),
			totals: toolTotals(currencyTotals(rows, documents.map(ledgerEntry), today)),
		};
	} catch (error) {
		if (refusalOf(error)?.error === MIGRATION_PENDING_ERROR) return { subscriptions: [], totals: [] };
		throw error;
	}
};
