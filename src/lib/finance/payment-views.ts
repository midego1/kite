import { getEnv } from "@/lib/cloudflare";
import { resolveRecordRefs } from "@/lib/modules/record-refs";
import { normalizeTimeZone } from "@/lib/time/utils";
import { MIGRATION_PENDING_ERROR, refusalOf } from "./errors";
import {
	ledgerStatus,
	monthTotals,
	pairedEntryIds,
	shownStatus,
	sortEntries,
	unpaidLedgerInvoices,
	type PaymentListEntry,
} from "./payment-list-utils";
import { ownerScan, scanView } from "./payment-scan";
import { ledgerMessageIds, ownerPayments, type PaymentRow } from "./payments";
import { dateToDay, type ChargeRow } from "./record-utils";
import { ownerDocuments, ownerRows } from "./subscriptions";
import type { ViewUser } from "./views";

/** At most this many rows are listed, newest first; totals and pairing still cover every row. */
const MAX_ROWS = 1_000;

function paymentEntry(row: PaymentRow): PaymentListEntry {
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
	};
}

function ledgerEntryOf(row: ChargeRow, vendor: string): PaymentListEntry {
	return {
		id: row.id,
		source: "subscription",
		docType: row.docType,
		status: ledgerStatus(row.docType),
		vendor,
		group: row.subscriptionId,
		amountMinor: row.amountMinor,
		currency: row.currency,
		documentOn: dateToDay(row.documentAt)!,
		periodStartOn: dateToDay(row.periodStartAt),
		messageId: row.messageId,
		subscriptionId: row.subscriptionId,
	};
}

/** A subscription invoice a failed payment followed is shown, and counted, as open. */
function withUnpaid(entries: readonly PaymentListEntry[], paired: ReadonlySet<string>): PaymentListEntry[] {
	const unpaid = unpaidLedgerInvoices(entries, paired);
	return entries.map((entry) => (unpaid.has(entry.id) ? { ...entry, status: "open" as const } : entry));
}

/**
 * Where a payment row's mail came from, from its vendor key: the domain ("stripe.com" for a processor's merchant), the
 * address for a person at a free mail provider, nothing for a row renamed by hand. Shown next to the vendor, so a
 * display name that borrows a known brand does not hide its real sender.
 * @public Exercised by the bundled unit tests.
 */
export function senderOf(vendorKey: string): string | null {
	if (vendorKey.startsWith("manual:")) return null;
	if (vendorKey.startsWith("mail:")) return vendorKey.slice("mail:".length) || null;
	return vendorKey.split(":")[0] || null;
}

function modelFieldsOf(row: PaymentRow | undefined): string[] {
	if (!row?.modelFields) return [];
	try {
		const parsed = JSON.parse(row.modelFields) as unknown;
		return Array.isArray(parsed) ? parsed.filter((field): field is string => typeof field === "string") : [];
	} catch {
		return [];
	}
}

async function messageRefs(user: ViewUser, entries: readonly PaymentListEntry[]) {
	const ids = [...new Set(entries.flatMap((entry) => (entry.messageId ? [entry.messageId] : [])))];
	if (ids.length === 0) return new Map();
	const resolved = await resolveRecordRefs(
		getEnv(),
		{ userId: user.userId, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin },
		ids.map((id) => ({ kind: "mail:message", id })),
		{ timeZone: normalizeTimeZone(user.timeZone), trigger: "api" },
	);
	return new Map(resolved.map((ref) => [ref.id, ref]));
}

/**
 * The Payments tab (spec §25.6): the owner's payment rows and every document of their tracked subscriptions, newest
 * first, with month totals per currency and the progress of "Scan last 90 days". A payment row whose message is in a
 * subscription's ledger is left out, so nothing counts twice. Before migration 0094: empty with `migrationPending`.
 */
export async function listPaymentsView(user: ViewUser) {
	try {
		const [payments, documents, subscriptions, inLedger, scan] = await Promise.all([
			ownerPayments(user.userId),
			ownerDocuments(user.userId),
			ownerRows(user.userId),
			ledgerMessageIds(user.userId),
			ownerScan(user.userId),
		]);
		const vendors = new Map(subscriptions.map((row) => [row.id, row.vendor]));
		const byId = new Map(payments.map((row) => [row.id, row]));
		const all = sortEntries([
			...payments.filter((row) => !row.messageId || !inLedger.has(row.messageId)).map(paymentEntry),
			...documents.map((row) => ledgerEntryOf(row, vendors.get(row.subscriptionId) ?? "")),
		]);
		// Pairing and totals cover every row; only the list is cut, and says so.
		const paired = pairedEntryIds(all);
		const entries = withUnpaid(all, paired);
		const listed = entries.slice(0, MAX_ROWS);
		const refs = await messageRefs(user, listed);
		return {
			truncated: entries.length > listed.length,
			payments: listed.map((entry) => ({
				id: entry.id,
				source: entry.source,
				docType: entry.docType,
				status: shownStatus(entry, paired),
				storedStatus: entry.status,
				paired: paired.has(entry.id),
				vendor: entry.vendor,
				amount:
					entry.amountMinor !== null && entry.currency ? { minor: entry.amountMinor, currency: entry.currency } : null,
				documentOn: entry.documentOn,
				subscriptionId: entry.subscriptionId,
				messageId: entry.messageId,
				message: entry.messageId ? (refs.get(entry.messageId) ?? null) : null,
				modelFields: modelFieldsOf(byId.get(entry.id)),
				sender: byId.has(entry.id) ? senderOf(byId.get(entry.id)!.vendorKey) : null,
				origin: byId.get(entry.id)?.source ?? null,
			})),
			months: monthTotals(entries, paired),
			scan: scanView(scan),
		};
	} catch (error) {
		if (refusalOf(error)?.error === MIGRATION_PENDING_ERROR)
			return { truncated: false, payments: [], months: [], scan: null, migrationPending: true as const };
		throw error;
	}
}
