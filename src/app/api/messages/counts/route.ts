import { count } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { buildMessageCounts } from "./utils";
import { listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { resolveMailboxScope } from "@/lib/mailboxes/scope-utils";
import { mailboxScopeCondition } from "@/lib/messages/mailbox-scope";

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

	const rows = await db
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
		.where(mailboxScopeCondition(scope.ids, user.id))
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

	return NextResponse.json({ counts: buildMessageCounts(rows) });
}
