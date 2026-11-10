import type { z } from "zod";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext, CapabilityHandler } from "@/lib/modules/module-types";
import { MIGRATION_PENDING_ERROR, refusalOf } from "./errors";
import { matchesPaymentFilter } from "./payment-filter-utils";
import { monthTotals, pairedEntryIds, shownStatus, sortEntries, type PaymentListEntry } from "./payment-list-utils";
import type { listPaymentsInput } from "./payment-tool-schema";
import { paymentRef } from "./payment-utils";
import { ledgerMessageIds, ownerPayments, type PaymentRow } from "./payments";
import { dateToDay } from "./record-utils";

/** `list_payments` shows the totals of this many of the newest months. */
const TOOL_MONTHS = 6;

type ToolInput = z.infer<typeof listPaymentsInput>;

function entryOf(row: PaymentRow): PaymentListEntry {
	return {
		id: row.id,
		source: "payment",
		docType: row.docType,
		status: row.status,
		vendor: row.vendor,
		group: `vendor:${row.vendorKey}`,
		amountMinor: row.amountMinor,
		currency: row.currency,
		documentOn: dateToDay(row.documentAt)!,
		periodStartOn: null,
		docRef: row.docRef,
		messageId: row.messageId,
		subscriptionId: null,
		category: row.category,
	};
}

/**
 * The owner's payment rows the chat may see: in the chat (`moduleHost.mail.aiHidden`, checked now) a row is left
 * out when its mail's mailbox has AI off, or the row was found there. A payment hidden from a message in a
 * subscription's ledger is left out here as in the tab.
 */
async function visibleRows(ctx: CapabilityCallContext, userId: string): Promise<PaymentRow[]> {
	const [rows, inLedger] = await Promise.all([ownerPayments(userId), ledgerMessageIds(userId)]);
	const shown = rows.filter((row) => !row.messageId || !inLedger.has(row.messageId));
	const hidden = await moduleHost.mail.aiHidden(
		ctx,
		shown.map((row) => ({
			mailboxIds: [row.mailboxId],
			messageIds: [row.messageId],
			refs: [paymentRef(row.id)],
		})),
	);
	return shown.filter((_, index) => !hidden[index]);
}

/** The totals of the newest few months (they come newest first), every currency of each. */
function newestMonths<T extends { month: string }>(totals: readonly T[]): T[] {
	const keep = new Set([...new Set(totals.map((total) => total.month))].slice(0, TOOL_MONTHS));
	return totals.filter((total) => keep.has(total.month));
}

/**
 * `list_payments`: the viewer's own payments found in mail (receipts, invoices, refunds and credit notes that are
 * not a tracked subscription's), newest first, narrowed by month, vendor, category and status, with month totals per
 * currency of the same rows. Read-only; before migration 0094 it lists nothing. Subscription charges are in
 * `list_subscriptions`, so the two never count one payment twice.
 */
export const listPaymentsTool: CapabilityHandler = async (raw, ctx) => {
	if (!ctx.viewer) throw new Error("list_payments needs a viewer");
	const input = raw as ToolInput;
	try {
		const rows = await visibleRows(ctx, ctx.viewer.userId);
		const entries = sortEntries(rows.map(entryOf));
		// Pairing runs over every row, so a paid invoice counts once whatever the filters leave out.
		const paired = pairedEntryIds(entries);
		const shown = entries
			.map((entry) => ({ ...entry, status: shownStatus(entry, paired) }))
			.filter((entry) => matchesPaymentFilter(entry, input));
		const byId = new Map(rows.map((row) => [row.id, row]));
		return {
			payments: shown.slice(0, input.limit).map((entry) => ({
				ref: paymentRef(entry.id),
				vendor: entry.vendor,
				docType: entry.docType,
				status: entry.status,
				amount: { minor: entry.amountMinor!, currency: entry.currency! },
				documentOn: entry.documentOn,
				category: byId.get(entry.id)?.category ?? null,
			})),
			months: newestMonths(monthTotals(shown, paired)),
		};
	} catch (error) {
		if (refusalOf(error)?.error === MIGRATION_PENDING_ERROR) return { payments: [], months: [] };
		throw error;
	}
};
