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
	type PaymentListEntry,
} from "./payment-list-utils";
import { ownerScan, scanView } from "./payment-scan";
import { ledgerMessageIds, ownerPayments, type PaymentRow } from "./payments";
import { dateToDay, type ChargeRow } from "./record-utils";
import { ownerDocuments, ownerRows } from "./subscriptions";
import type { ViewUser } from "./views";

/** At most this many rows are listed; months older than the newest rows are dropped first. */
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
		const entries = sortEntries([
			...payments.filter((row) => !row.messageId || !inLedger.has(row.messageId)).map(paymentEntry),
			...documents.map((row) => ledgerEntryOf(row, vendors.get(row.subscriptionId) ?? "")),
		]).slice(0, MAX_ROWS);
		const paired = pairedEntryIds(entries);
		const refs = await messageRefs(user, entries);
		return {
			payments: entries.map((entry) => ({
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
				origin: byId.get(entry.id)?.source ?? null,
			})),
			months: monthTotals(entries, paired),
			scan: scanView(scan),
		};
	} catch (error) {
		if (refusalOf(error)?.error === MIGRATION_PENDING_ERROR)
			return { payments: [], months: [], scan: null, migrationPending: true as const };
		throw error;
	}
}
