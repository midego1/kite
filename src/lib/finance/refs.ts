import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { financePayments, financeSubscriptions } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { selectRows } from "@/lib/db/pending-columns";
import {
	forEachIdChunk,
	idsOfKind,
	refKey,
	refsOf,
	refsOutput,
	viewerId,
	type FoundRef,
} from "@/lib/modules/handler-helpers";
import type { CapabilityHandler } from "@/lib/modules/module-types";
import { isSameOriginPath } from "@/lib/modules/path-utils";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { financeTablesReady } from "./errors";
import { paymentTablesReady } from "./payments";
import { paymentHref, paymentLabel } from "./payment-utils";
import { subscriptionHref, subscriptionLabel } from "./record-utils";

const KIND = "finance:subscription";
const PAYMENT_KIND = "finance:payment";

/** The viewer's own payment rows among `ids`, by `finance:payment` ref; a removed row reads as unavailable. */
async function resolvePayments(ids: string[], userId: string, locale: string, found: Map<string, FoundRef>) {
	if (ids.length === 0 || !(await paymentTablesReady())) return;
	const db = getDb(getEnv());
	await forEachIdChunk(ids, async (chunk) => {
		const rows = await selectRows(
			db,
			financePayments,
			and(eq(financePayments.userId, userId), isNull(financePayments.removedAt), inArray(financePayments.id, chunk)),
		);
		for (const row of rows) {
			const href = paymentHref(row.id);
			found.set(refKey(PAYMENT_KIND, row.id), {
				href: isSameOriginPath(href) ? href : null,
				label: paymentLabel(row, locale),
			});
		}
	});
}

/**
 * A subscription or a payment is visible to its owner and to nobody else; before migration 0063 (0094 for a
 * payment) every ref reads as unavailable.
 */
export const resolveFinanceRefs: CapabilityHandler = async (input, ctx) => {
	const refs = refsOf(input);
	const userId = viewerId(ctx);
	const found = new Map<string, FoundRef>();
	const ids = idsOfKind(refs, KIND);
	const paymentIds = idsOfKind(refs, PAYMENT_KIND);
	if (!userId || (ids.length === 0 && paymentIds.length === 0) || !(await financeTablesReady()))
		return refsOutput(refs, found);
	const db = getDb(getEnv());
	try {
		await resolvePayments(paymentIds, userId, ctx.locale, found);
		await forEachIdChunk(ids, async (chunk) => {
			const rows = await db
				.select({
					id: financeSubscriptions.id,
					vendor: financeSubscriptions.vendor,
					amountMinor: financeSubscriptions.amountMinor,
					currency: financeSubscriptions.currency,
					cycle: financeSubscriptions.cycle,
				})
				.from(financeSubscriptions)
				.where(and(eq(financeSubscriptions.userId, userId), inArray(financeSubscriptions.id, chunk)));
			for (const row of rows) {
				const href = subscriptionHref(row.id);
				found.set(refKey(KIND, row.id), {
					href: isSameOriginPath(href) ? href : null,
					label: subscriptionLabel(row, ctx.locale),
				});
			}
		});
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
		found.clear();
	}
	return refsOutput(refs, found);
};
