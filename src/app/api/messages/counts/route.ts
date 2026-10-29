import { and, count, eq, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { buildMessageCounts } from "./utils";
import { listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { resolveMailboxScope } from "@/lib/mailboxes/scope-utils";
import { mailboxRowsCondition } from "@/lib/messages/mailbox-scope";
import { DRAFT_STATUS } from "@/lib/messages/draft-privacy-utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const db = getDb(env);
	// One mailbox, the All mailboxes view's filter, or every mailbox the user can open; the
	// counts of several mailboxes add up, row by row, in buildMessageCounts.
	const scope = resolveMailboxScope(
		{ mailboxId: url.searchParams.get("mailboxId"), mailboxIds: url.searchParams.get("mailboxIds") },
		await listAccessibleMailboxIds(db, user),
	);
	if (!scope.ok) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const grouped = (where: SQL) =>
		db
			.select({
				mailboxId: messages.mailboxId,
				folderId: messages.folderId,
				direction: messages.direction,
				status: messages.status,
				read: messages.read,
				starred: messages.starred,
				snoozedUntil: messages.snoozedUntil,
				total: count(),
			})
			.from(messages)
			.where(where)
			// Same column order as messages_counts_idx, so SQLite groups straight off the index.
			.groupBy(
				messages.mailboxId,
				messages.status,
				messages.direction,
				messages.folderId,
				messages.read,
				messages.starred,
				messages.snoozedUntil,
			);
	// Drafts are private to their author. They are counted on their own so the main query never
	// reads the author column and keeps grouping straight off the index.
	const inScope = mailboxRowsCondition(scope.ids, user.id);
	const [rows, drafts] = await Promise.all([
		grouped(and(inScope, ne(messages.status, DRAFT_STATUS))!),
		grouped(and(inScope, eq(messages.status, DRAFT_STATUS), eq(messages.userId, user.id))!),
	]);

	return NextResponse.json({ counts: buildMessageCounts([...rows, ...drafts]) });
}
