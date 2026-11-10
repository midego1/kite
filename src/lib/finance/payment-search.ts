import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { financePayments } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { selectRows } from "@/lib/db/pending-columns";
import type { CapabilityHandler } from "@/lib/modules/module-types";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { paymentTablesReady } from "./payments";
import { paymentHref, paymentLabel, paymentRef } from "./payment-utils";
import { paymentSublabel } from "./payment-search-utils";
import { containsPattern } from "./search-utils";

/** The Payments section never lists more than this many rows (spec §27.5). */
const MAX_ITEMS = 10;

/**
 * The viewer's own payments found in mail whose vendor or document number contains the query, newest first. A row
 * removed by the owner, and one whose message is in a subscription's ledger (the tab leaves it out too), is not
 * listed. Before migrations 0094 and 0109 there is nothing to search or no category to show, which is an empty
 * answer or a missing label, not a failure.
 */
export const searchPayments: CapabilityHandler = async (input, ctx) => {
	if (!ctx.viewer || !(await paymentTablesReady())) return { items: [] };
	const { query, limit } = input as { query: string; limit: number };
	const pattern = containsPattern(query);
	try {
		const rows = await selectRows(
			getDb(getEnv()),
			financePayments,
			and(
				eq(financePayments.userId, ctx.viewer.userId),
				isNull(financePayments.removedAt),
				or(
					sql`${financePayments.vendor} LIKE ${pattern} ESCAPE '\\'`,
					sql`${financePayments.docRef} LIKE ${pattern} ESCAPE '\\'`,
				),
				sql`NOT EXISTS (SELECT 1 FROM finance_charges WHERE finance_charges.user_id = ${financePayments.userId} AND finance_charges.message_id = ${financePayments.messageId})`,
			),
			Math.min(limit, MAX_ITEMS),
			sql`${financePayments.documentAt} DESC, ${financePayments.id} ASC`,
		);
		return {
			items: rows.map((row) => ({
				ref: paymentRef(row.id),
				label: paymentLabel(row, ctx.locale),
				sublabel: paymentSublabel(row),
				href: paymentHref(row.id),
			})),
		};
	} catch (error) {
		if (isNoSuchTableError(error)) return { items: [] };
		throw error;
	}
};
