import { NextResponse } from "next/server";
import { eq, desc, and, or, count, isNull, isNotNull, inArray, lte, gt, ne, notInArray, sql, sum } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getContactDisplayNameMap } from "@/lib/contacts/service";
import { getSenderDisplayName } from "@/lib/contacts/utils";
import { getFirstEmailAddressEntry, normalizeEmailAddress } from "@/lib/email/address";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { tracksAccountIdentity } from "@/lib/profile/identity-utils";
import { buildSearchConditions } from "@/lib/search/conditions";
import { getRequestTimeZone } from "@/lib/time/utils";
import { queryInChunks } from "@/db/chunk-utils";
import { decodeMessageCursor, getNextMessageCursor } from "@/lib/messages/cursor-utils";
import { ownedStatusCondition } from "@/lib/modules/message-status";
import { loadRowSuggestions } from "@/lib/agent/auto-read/message-suggestions";
import { loadRowLines } from "@/lib/agent/summaries/lines";
import { suggestionVisibilityFor } from "@/lib/agent/auto-read/suggestion-visibility";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import { loadSendStates, statusFilterCondition } from "@/lib/messages/send-state";
import { parseStatusFilter } from "@/lib/messages/send-state-utils";
import { loadRowsWithAttachments } from "@/lib/messages/attachment-flags";
import { screenerPendingRows } from "@/lib/screener/views";
import { resolveMailboxScope } from "@/lib/mailboxes/scope-utils";
import { mailboxScopeCondition } from "@/lib/messages/mailbox-scope";
import { conversationKey, rowConversationKey } from "@/lib/messages/conversation-key";
import { afterCursor, getMessageListColumns, loadConversationPage } from "./utils";
import { groupThreadMembers, type ScopedThreads } from "@/lib/messages/thread-unread-utils";
import type { ListMessage } from "./types";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const direction = url.searchParams.get("direction");
	const folderId = url.searchParams.get("folderId");
	const status = url.searchParams.get("status");
	const query = url.searchParams.get("q")?.trim();
	const title = url.searchParams.get("title")?.trim();
	const read = url.searchParams.get("read");
	const starred = url.searchParams.get("starred");
	const snoozed = url.searchParams.get("snoozed");
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
	const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
	// Keyset pagination; `offset` keeps working for callers that do not send a cursor.
	const cursorParam = url.searchParams.get("cursor");
	const cursor = decodeMessageCursor(cursorParam);
	if (cursorParam && !cursor) {
		return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
	}
	// Conversation view: one row per thread, represented by its newest message
	// that matches the filter. Drafts are never grouped.
	const groupByThread = url.searchParams.get("group") === "thread" && status !== "draft";

	const db = getDb(env);
	const accessibleMailboxes = await listAccessibleMailboxes(db, user);
	const accessibleMailboxIds = accessibleMailboxes.map((mailbox) => mailbox.id);
	// Every mailbox in the accessible list is readable, so this is the same check
	// getMailboxAccessLevel makes without querying the mailbox again.
	const mailboxScope = resolveMailboxScope(
		{ mailboxId: url.searchParams.get("mailboxId"), mailboxIds: url.searchParams.get("mailboxIds") },
		accessibleMailboxIds,
	);
	if (!mailboxScope.ok) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const scope = mailboxScopeCondition(mailboxScope.ids, user.id);
	const conditions: SQL[] = [scope];
	if (direction === "inbound" || direction === "outbound") {
		conditions.push(eq(messages.direction, direction));
	}
	if (folderId) {
		conditions.push(eq(messages.folderId, folderId));
	}
	// `status` may list several (the Sent folder also holds queued and failed sends).
	const statuses = parseStatusFilter(status);
	if (statuses) {
		conditions.push(statusFilterCondition(statuses));
	}
	// Held mail shows only in the Screener view, never in starred, folder or search results.
	if (status !== SCREENING_STATUS) conditions.push(ne(messages.status, SCREENING_STATUS));
	const ownedStatus = await ownedStatusCondition(
		env,
		{ userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin },
		status,
	);
	if (ownedStatus) conditions.push(ownedStatus);
	if (status === "received" && !folderId) {
		conditions.push(isNull(messages.folderId));
		conditions.push(or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, new Date()))!);
	}
	if (starred === "true") {
		conditions.push(eq(messages.starred, true));
	}
	if (snoozed === "true") {
		conditions.push(eq(messages.status, "received"));
		conditions.push(isNull(messages.folderId));
		conditions.push(gt(messages.snoozedUntil, new Date()));
	}
	if (read === "read") {
		conditions.push(eq(messages.read, true));
	}
	if (read === "unread") {
		conditions.push(eq(messages.read, false));
	}
	if (query || title) {
		// Operators (from:, has:attachment, before:) and free text go through the
		// full-text index; `title` is the legacy subject filter and is folded in.
		conditions.push(
			...buildSearchConditions(
				title ? `${query ?? ""} subject:"${title}"` : (query ?? ""),
				getRequestTimeZone(request, user.timeZone),
			),
		);
	}
	const where = and(...conditions);
	// Messages that were never threaded (older rows, drafts) stand alone, and a conversation
	// never spans mailboxes: the same Message-ID delivered to two of them is two threads.
	const threadKey = conversationKey();

	// The list renders `snippet`. Bodies stay on the thread endpoint.
	const messageListColumns = getMessageListColumns();

	let total = 0;
	let rows: ListMessage[];
	let nextCursor: string | null = null;
	// Which stored messages each visible row stands for, so acting on a
	// conversation row acts on the whole conversation within this folder.
	let scopedThreads: ScopedThreads = { ids: new Map(), unread: new Map(), inbound: new Map() };
	if (groupByThread) {
		const page = await loadConversationPage({ db, where, offset, limit, cursor });
		total = page.total;
		// The ids already satisfy `where`; repeating it would only add bound parameters.
		rows = await queryInChunks(page.ids, (ids) =>
			db.select(messageListColumns).from(messages).where(inArray(messages.id, ids)),
		);
		const rowById = new Map(rows.map((row) => [row.id, row]));
		rows = page.ids.map((id) => rowById.get(id)).filter((row): row is ListMessage => !!row);
		nextCursor = getNextMessageCursor(rows, limit);
		const keys = rows.map(rowConversationKey);
		if (keys.length > 0) {
			const members = await queryInChunks(keys, (chunk) =>
				db
					.select({ id: messages.id, key: threadKey, read: messages.read, direction: messages.direction })
					.from(messages)
					.where(and(where, inArray(threadKey, chunk))),
			);
			scopedThreads = groupThreadMembers(members);
		}
	} else {
		const [[totalRow], pageRows] = await Promise.all([
			db.select({ total: count() }).from(messages).where(where),
			db
				.select(messageListColumns)
				.from(messages)
				.where(cursor ? and(where, afterCursor(messages.createdAt, messages.id, cursor)) : where)
				.orderBy(desc(messages.createdAt), desc(messages.id))
				.limit(limit)
				.offset(cursor ? 0 : offset),
		]);
		total = totalRow?.total ?? 0;
		rows = pageRows;
		nextCursor = getNextMessageCursor(rows, limit);
	}
	// Conversation sizes for the rows on this page, so the list can show "(3)"
	// next to a subject the way threaded clients do.
	const threadIds = Array.from(new Set(rows.map((row) => row.threadId).filter((id): id is string => !!id)));
	const threadCounts = new Map<string, { total: number; unread: number }>();
	if (threadIds.length > 0) {
		const countRows = await queryInChunks(threadIds, (chunk) =>
			db
				.select({
					mailboxId: messages.mailboxId,
					threadId: messages.threadId,
					total: count(),
					unread: sum(sql`case when ${messages.read} = 0 and ${messages.direction} = 'inbound' then 1 else 0 end`),
				})
				.from(messages)
				.where(
					and(
						scope,
						inArray(messages.threadId, chunk),
						isNotNull(messages.threadId),
						notInArray(messages.status, ["draft", "trash", SCREENING_STATUS]),
					),
				)
				.groupBy(messages.mailboxId, messages.threadId),
		);
		for (const row of countRows) {
			if (row.threadId)
				threadCounts.set(rowConversationKey({ ...row, id: row.threadId }), {
					total: row.total,
					unread: Number(row.unread ?? 0),
				});
		}
	}
	const mailboxNameMap = new Map(
		accessibleMailboxes.map((mailbox) => [
			mailbox.id,
			mailbox.userId === user.id && tracksAccountIdentity(mailbox, user.email)
				? user.name
				: (mailbox.displayName ?? mailbox.localPart),
		]),
	);
	const contactMapsByUserId = new Map(
		await Promise.all(
			Array.from(new Set(rows.map((message) => message.userId))).map(
				async (userId) =>
					[
						userId,
						await getContactDisplayNameMap(
							env,
							userId,
							rows
								.filter((message) => message.userId === userId)
								.flatMap((message) => [message.fromAddr, getFirstEmailAddressEntry(message.toAddr)]),
						),
					] as const,
			),
		),
	);
	const rowSuggestions = await loadRowSuggestions(
		db,
		accessibleMailboxes,
		rows,
		scopedThreads.ids,
		await suggestionVisibilityFor(env, user),
	);
	const screenerPending = await screenerPendingRows(db, rows);
	const sendStates = await loadSendStates(db, rows, user.id);
	// A conversation row has an attachment when any message it stands for in this folder does.
	const withAttachments = await loadRowsWithAttachments(db, rows, (row) =>
		groupByThread ? (scopedThreads.ids.get(rowConversationKey(row)) ?? [row.id]) : [row.id],
	);
	// One-line summaries, for mailboxes that have them on; a conversation row shows its newest message's line.
	const rowLines = await loadRowLines(db, rows, (row) =>
		groupByThread ? (scopedThreads.ids.get(rowConversationKey(row)) ?? [row.id]) : [row.id],
	);
	// `Message.textBody`/`htmlBody` are optional on the wire type and the
	// reading pane loads them from /api/messages/[id]/thread, so they are
	// neither selected nor sent here.
	const enrichedRows = rows.map(({ rawR2Key: _rawR2Key, ...message }) => {
		const contactMap = contactMapsByUserId.get(message.userId);
		const accountName = message.mailboxId ? mailboxNameMap.get(message.mailboxId) : null;
		const key = rowConversationKey(message);
		const threadCount = message.threadId ? threadCounts.get(key) : undefined;
		return {
			...message,
			snippet: message.snippet,
			fromContactName:
				(message.direction === "outbound" ? accountName : null) ??
				getSenderDisplayName(message.fromAddr, contactMap?.get(normalizeEmailAddress(message.fromAddr))),
			toContactName:
				contactMap?.get(normalizeEmailAddress(getFirstEmailAddressEntry(message.toAddr)))?.displayName ?? null,
			threadCount: threadCount?.total || 1,
			// A conversation row is unread only when a message it stands for in this folder is.
			threadUnread: (groupByThread ? scopedThreads.unread.get(key) : threadCount?.unread) || 0,
			hasAttachments: withAttachments.has(message.id),
			...rowSuggestions(message.id),
			...rowLines(message.id),
			...(screenerPending.has(message.id) ? { screenerPending: true } : {}),
			...(sendStates.has(message.id) ? { sendState: sendStates.get(message.id) } : {}),
			...(groupByThread
				? {
						threadMessageIds: scopedThreads.ids.get(key) ?? [message.id],
						threadInboundCount: scopedThreads.inbound.get(key) ?? 0,
					}
				: {}),
		};
	});

	return NextResponse.json({ messages: enrichedRows, total, limit, offset, nextCursor, grouped: groupByThread });
}
