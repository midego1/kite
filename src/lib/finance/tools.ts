import type { CapabilityHandler } from "@/lib/modules/module-types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { dayInTimeZone } from "./date-utils";
import { MIGRATION_PENDING_ERROR, refusalOf } from "./errors";
import { ledgerEntry } from "./record-utils";
import { ownerDocuments, ownerRows } from "./subscriptions";
import { currencyTotals } from "./totals-utils";
import { selectToolRows, toolSubscription, toolTotals, type ToolInput } from "./tool-utils";

/**
 * `list_subscriptions`: the viewer's own subscriptions the input asks for, and the totals over all of
 * them, including what was paid in the last 12 months. Read-only; before migration 0063 it lists nothing.
 */
export const listSubscriptionsTool: CapabilityHandler = async (input, ctx) => {
	if (!ctx.viewer) throw new Error("list_subscriptions needs a viewer");
	const today = dayInTimeZone(new Date().toISOString(), normalizeTimeZone(ctx.timeZone));
	try {
		const [rows, documents] = await Promise.all([ownerRows(ctx.viewer.userId), ownerDocuments(ctx.viewer.userId)]);
		return {
			subscriptions: selectToolRows(rows, input as ToolInput, today).map(toolSubscription),
			totals: toolTotals(currencyTotals(rows, documents.map(ledgerEntry), today)),
		};
	} catch (error) {
		if (refusalOf(error)?.error === MIGRATION_PENDING_ERROR) return { subscriptions: [], totals: [] };
		throw error;
	}
};
