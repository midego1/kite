import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { inJsonArray } from "@/db/chunk-utils";
import { messageAttachments } from "@/db/schema";
import { rowsWithAttachments } from "./attachment-flags-utils";

/**
 * The list rows that have a real attachment, for `hasAttachments`: `disposition = 'attachment'`, the same test
 * as the `has:attachment` search operator, so a cid-referenced inline image does not count. One query for the
 * page however many messages the conversation rows stand for: the ids travel as a single JSON parameter, which
 * keeps clear of D1's 100-parameter limit, and `message_attachments_message_idx` serves the lookup.
 */
export async function loadRowsWithAttachments<Row extends { id: string }>(
	db: AppDatabase,
	rows: readonly Row[],
	idsFor: (row: Row) => readonly string[],
): Promise<Set<string>> {
	const ids = [...new Set(rows.flatMap((row) => idsFor(row)))];
	if (ids.length === 0) return new Set();
	const found = await db
		.selectDistinct({ messageId: messageAttachments.messageId })
		.from(messageAttachments)
		.where(and(inJsonArray(messageAttachments.messageId, ids), eq(messageAttachments.disposition, "attachment")));
	return rowsWithAttachments(rows, idsFor, new Set(found.map((row) => row.messageId)));
}
