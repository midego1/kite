import { getEnv } from "@/lib/cloudflare";
import { resolveRecordRefs } from "@/lib/modules/record-refs";
import type { RefViewer } from "@/lib/modules/record-ref-types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { dayInTimeZone } from "./date-utils";
import { MIGRATION_PENDING_ERROR, refusalOf } from "./errors";
import { documentView, ledgerEntry, statusesOf, subscriptionView } from "./record-utils";
import { ownerDocuments, ownerRow, ownerRows } from "./subscriptions";
import { currencyTotals, pairedDocumentIds, paidLast12Months } from "./totals-utils";

export type ViewUser = RefViewer & { timeZone: string | null };

const viewerOf = (user: ViewUser): RefViewer => ({
	userId: user.userId,
	role: user.role,
	isPrimaryAdmin: user.isPrimaryAdmin,
});

const todayFor = (user: ViewUser) => dayInTimeZone(new Date().toISOString(), normalizeTimeZone(user.timeZone));

/** Before migration 0063 the views answer empty with `migrationPending` instead of failing. */
async function orPending<T, P>(run: () => Promise<T>, pending: P): Promise<T | P> {
	try {
		return await run();
	} catch (error) {
		if (refusalOf(error)?.error === MIGRATION_PENDING_ERROR) return pending;
		throw error;
	}
}

/**
 * The owner's subscriptions with the given statuses, and the totals over all of them: monthly and
 * yearly cost per currency and what the ledger says was paid in the last 12 months.
 */
export async function listSubscriptionsView(user: ViewUser, status: string | null) {
	return orPending(
		async () => {
			const statuses = statusesOf(status);
			const [rows, documents] = await Promise.all([ownerRows(user.userId), ownerDocuments(user.userId)]);
			return {
				subscriptions: rows.filter((row) => statuses.includes(row.status)).map(subscriptionView),
				totals: currencyTotals(rows, documents.map(ledgerEntry), todayFor(user)),
			};
		},
		{ subscriptions: [], totals: [], migrationPending: true as const },
	);
}

/**
 * One of the owner's subscriptions with its paid total for the last 12 months and its documents,
 * newest first, each with its source message resolved for the owner; null for anyone else.
 */
export async function subscriptionDetailView(user: ViewUser, id: string) {
	return orPending(
		async () => {
			const row = await ownerRow(user.userId, id);
			if (!row) return null;
			const documents = await ownerDocuments(user.userId, row.id);
			const entries = documents.map(ledgerEntry);
			const paired = pairedDocumentIds(entries);
			const paid = paidLast12Months(entries, todayFor(user));
			const messageRefs = documents.flatMap((document) =>
				document.messageId ? [{ kind: "mail:message", id: document.messageId }] : [],
			);
			const resolved = await resolveRecordRefs(getEnv(), viewerOf(user), messageRefs, {
				timeZone: normalizeTimeZone(user.timeZone),
				trigger: "api",
			});
			const byId = new Map(resolved.map((ref) => [ref.id, ref]));
			return {
				subscription: subscriptionView(row),
				paidLast12Months: [...paid.entries()].map(([currency, minor]) => ({ currency, minor })),
				documents: documents.map((document) => ({
					...documentView(document, paired.has(document.id)),
					message: document.messageId ? (byId.get(document.messageId) ?? null) : null,
				})),
			};
		},
		{ migrationPending: true as const },
	);
}
