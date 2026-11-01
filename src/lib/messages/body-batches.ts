import { getTableColumns, inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { planBodyBatches } from "./body-batch-utils";

/** Stored body bytes of a message row, to select next to its other columns instead of the bodies. */
export const bodyBytesColumn = sql<number>`length(cast(coalesce(${messages.textBody}, '') as blob)) + length(cast(coalesce(${messages.htmlBody}, '') as blob))`;

const { textBody: _textBody, htmlBody: _htmlBody, ...columnsWithoutBodies } = getTableColumns(messages);

/** Every message column but the bodies, plus `bodyBytes`: the select list for `withStoredBodies`. */
export const messageColumnsWithoutBodies = { ...columnsWithoutBodies, bodyBytes: bodyBytesColumn };

type StoredBodies = { textBody: string | null; htmlBody: string | null };

/**
 * `rows` (selected without their bodies, with `bodyBytes`) with `textBody` and `htmlBody` filled in, in order.
 * A row that no longer exists when its bodies are read is left out.
 * The bodies are read in batches of a bounded size, because D1 fails a query whose result passes 50 MB and a
 * list of messages can carry several megabytes of body each.
 */
export async function withStoredBodies<T extends { id: string; bodyBytes: number }>(
	db: AppDatabase,
	rows: readonly T[],
): Promise<(Omit<T, "bodyBytes"> & StoredBodies)[]> {
	const bodies = new Map<string, StoredBodies>();
	for (const ids of planBodyBatches(rows)) {
		for (const row of await db
			.select({ id: messages.id, textBody: messages.textBody, htmlBody: messages.htmlBody })
			.from(messages)
			.where(inArray(messages.id, ids)))
			bodies.set(row.id, row);
	}
	// A row deleted between the two queries has no bodies to return: drop it, as one query would not have had it.
	return rows
		.filter((row) => bodies.has(row.id))
		.map(({ bodyBytes: _bodyBytes, ...row }) => ({ ...row, ...(bodies.get(row.id) as StoredBodies) }));
}
