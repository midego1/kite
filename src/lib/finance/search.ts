import { and, asc, eq, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { financeSubscriptions } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import type { CapabilityHandler } from "@/lib/modules/module-types";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { financeTablesReady } from "./errors";
import { subscriptionHref, subscriptionLabel, subscriptionRef } from "./record-utils";
import { containsPattern, searchSublabel } from "./search-utils";

/** The Subscriptions section never lists more than this many rows (spec §14). */
const MAX_ITEMS = 10;

/**
 * The viewer's own subscriptions whose vendor or plan contains the query, by vendor. Before migration
 * 0063 there is nothing to search, which is an empty answer, not a failure.
 */
export const searchSubscriptions: CapabilityHandler = async (input, ctx) => {
	if (!ctx.viewer || !(await financeTablesReady())) return { items: [] };
	const { query, limit } = input as { query: string; limit: number };
	const pattern = containsPattern(query);
	const matches = (column: typeof financeSubscriptions.vendor | typeof financeSubscriptions.plan) =>
		sql`${column} LIKE ${pattern} ESCAPE '\\'`;
	try {
		const rows = await getDb(getEnv())
			.select()
			.from(financeSubscriptions)
			.where(
				and(
					eq(financeSubscriptions.userId, ctx.viewer.userId),
					or(matches(financeSubscriptions.vendor), matches(financeSubscriptions.plan)),
				),
			)
			.orderBy(asc(sql`${financeSubscriptions.vendor} COLLATE NOCASE`), asc(financeSubscriptions.id))
			.limit(Math.min(limit, MAX_ITEMS));
		return {
			items: rows.map((row) => ({
				ref: subscriptionRef(row.id),
				label: subscriptionLabel(row, ctx.locale),
				sublabel: searchSublabel(row),
				href: subscriptionHref(row.id),
			})),
		};
	} catch (error) {
		if (isNoSuchTableError(error)) return { items: [] };
		throw error;
	}
};
