import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { financeSubscriptions } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
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
import { subscriptionHref, subscriptionLabel } from "./record-utils";

const KIND = "finance:subscription";

/**
 * A subscription is visible to its owner and to nobody else; before migration 0063 every ref reads as
 * unavailable.
 */
export const resolveFinanceRefs: CapabilityHandler = async (input, ctx) => {
	const refs = refsOf(input);
	const userId = viewerId(ctx);
	const found = new Map<string, FoundRef>();
	if (!userId) return refsOutput(refs, found);
	const db = getDb(getEnv());
	try {
		await forEachIdChunk(idsOfKind(refs, KIND), async (chunk) => {
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
