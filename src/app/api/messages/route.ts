import { NextResponse } from "next/server";
import {
	eq,
	desc,
	and,
	or,
	count,
	countDistinct,
	isNull,
	isNotNull,
	inArray,
	lte,
	gt,
	ne,
	notInArray,
	sql,
	sum,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getDb, type AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { getContactDisplayNameMap } from "@/lib/contacts/service";
import { getPartyDisplayName } from "@/lib/contacts/utils";
import { getFirstEmailAddressEntry, normalizeEmailAddress } from "@/lib/email/address";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { tracksAccountIdentity } from "@/lib/profile/identity-utils";
import { buildSearchConditions } from "@/lib/search/conditions";
import { parseSearchQuery } from "@/lib/search/query-utils";
import { getRequestTimeZone } from "@/lib/time/utils";
import { semanticSearch } from "@/lib/semantic/search";
import type { SemanticMatch } from "@/lib/semantic/fusion-utils";
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
import { loadMessageVia, viaSearchAvailable } from "@/lib/external-accounts/via";
import { resolveMailboxScope } from "@/lib/mailboxes/scope-utils";
import { mailboxScopeCondition } from "@/lib/messages/mailbox-scope";
import { conversationKey, rowConversationKey } from "@/lib/messages/conversation-key";
import { getMessageListColumns, loadConversationPage } from "./utils";
import { afterCursor } from "@/lib/messages/cursor-sql";
import { groupThreadMembers, type ScopedThreads } from "@/lib/messages/thread-unread-utils";
import type { ListMessage } from "./types";

type ListQueryResolution = {
	hybridIds: string[] | null;
	matchByMessageId: Map<string, SemanticMatch> | null;
	semanticStatus?: "on" | "unavailable";
	semanticReason?: string;
	/** How many messages the plain keyword text alone matches, for a hybrid page's "Show all N keyword matches"
	 * (N-1 of review round 4): the fused, capped list a hybrid page returns is not a prefix of this list (it is
	 * ranked by relevance, not date), so there is no cursor that reaches the rest without skipping or repeating
	 * rows — only turning meaning off and running the plain, complete, date-ordered keyword path does. */
	keywordTotal?: number;
};

/**
 * `q`/`title` into `conditions` (pushed in place) and, when `tryHybrid` (no cursor, the By meaning chip is not
 * turned off for this request) and there is free text, a fused and D1-rechecked id order from `semanticSearch`
 * instead of the plain keyword condition (`docs/specs/semantic-search.md` section 4.6). Conversation view groups
 * these same ids by thread afterwards (below); the grouping itself needs no change here.
 */
async function resolveListQuery(input: {
	env: CloudflareEnv;
	conditions: SQL[];
	query: string | undefined;
	title: string | undefined;
	timeZone: string;
	mailboxIds: string[];
	tryHybrid: boolean;
	groupByThread: boolean;
}): Promise<ListQueryResolution> {
	const { env, conditions, query, title, timeZone, mailboxIds, groupByThread } = input;
	if (!query && !title) return { hybridIds: null, matchByMessageId: null };
	// Operators (from:, has:attachment, before:) and free text go through the
	// full-text index; `title` is the legacy subject filter and is folded in.
	const search = title ? `${query ?? ""} subject:"${title}"` : (query ?? "");
	const connectedAccounts = await viaSearchAvailable(env, search);
	const parsed = parseSearchQuery(search, timeZone);
	if (!input.tryHybrid || parsed.text.trim().length === 0) {
		conditions.push(...buildSearchConditions(search, timeZone, { connectedAccounts }));
		return { hybridIds: null, matchByMessageId: null };
	}
	const operatorConditions = buildSearchConditions(search, timeZone, { connectedAccounts, includeFullText: false });
	// `semanticSearch` answers "off" (the feature or the assistant is off, or the query is too short to embed) and
	// "unavailable" (a real runtime failure) exactly alike here: both mean no meaning run to use, so the ordinary
	// keyword path is unchanged for the overwhelming majority of installs, which have the feature off by default
	// (C-1 of review round 3: this used to only check for `!== "on"`, but "off" itself answered "on" quietly, so
	// every default-install search took the capped, unpaged hybrid path below for no reason).
	const result = await semanticSearch({
		env,
		scopeWhere: and(...conditions, ...operatorConditions)!,
		queryText: parsed.text,
		mailboxIds,
	});
	if (result.semantic !== "on") {
		conditions.push(...buildSearchConditions(search, timeZone, { connectedAccounts }));
		return {
			hybridIds: null,
			matchByMessageId: null,
			...(result.semantic === "unavailable"
				? { semanticStatus: result.semantic, semanticReason: result.semanticReason }
				: {}),
		};
	}
	const fullConditions = buildSearchConditions(search, timeZone, { connectedAccounts });
	const keywordWhere = and(...conditions, ...fullConditions);
	const [{ total: keywordTotal }] = groupByThread
		? await getDb(env)
				.select({ total: countDistinct(conversationKey()) })
				.from(messages)
				.where(keywordWhere)
		: await getDb(env).select({ total: count() }).from(messages).where(keywordWhere);
	conditions.push(...operatorConditions);
	return {
		hybridIds: result.ids,
		matchByMessageId: result.matches,
		semanticStatus: result.semantic,
		keywordTotal,
	};
}

/**
 * One row per thread from a fused, relevance-ordered id list: a thread is ranked by the best position any of its
 * matching messages reached (so a meaning-only hit still lifts its thread), but the representative shown for it is
 * its newest matching message, the same convention as every other conversation view row (a bug this route's own
 * tests enforce: an attachment on an older message of the thread must still show through the newest row).
 * `loaded` need not be in `ids` order; `ids` decides the thread rank.
 */
function representativeRowsByThread(ids: readonly string[], loaded: readonly ListMessage[]): ListMessage[] {
	const rowById = new Map(loaded.map((row) => [row.id, row]));
	const order: string[] = [];
	const newestByKey = new Map<string, ListMessage>();
	for (const id of ids) {
		const row = rowById.get(id);
		if (!row) continue;
		const key = rowConversationKey(row);
		const current = newestByKey.get(key);
		if (!current) {
			order.push(key);
			newestByKey.set(key, row);
		} else if (row.createdAt > current.createdAt) {
			newestByKey.set(key, row);
		}
	}
	return order.map((key) => newestByKey.get(key)!);
}

/**
 * How many of `ids` are a keyword match ("keyword" or "both" — only "meaning" is excluded), for "Show all N keyword
 * matches" (N-2 of review round 5): `total` on a hybrid page counts meaning-only rows too, so comparing `keywordTotal`
 * against `total` missed every case where the cap filled up with a mix of keyword and meaning-only rows rather than
 * meaning-only rows alone — a search with, say, 40 keyword and 30 meaning-only hits fuses to a 50-row page that is
 * about half meaning-only, leaving 15 keyword matches out with no link to reach them and no sign anything was cut.
 */
function keywordRowCount(ids: readonly string[], matchByMessageId: Map<string, SemanticMatch> | null): number {
	return ids.filter((id) => matchByMessageId?.get(id) !== "meaning").length;
}

/** `keywordRowCount`, by thread: a thread counts once it has at least one keyword or "both" id among `ids`. */
function keywordThreadCount(
	ids: readonly string[],
	loaded: readonly ListMessage[],
	matchByMessageId: Map<string, SemanticMatch> | null,
): number {
	const rowById = new Map(loaded.map((row) => [row.id, row]));
	const keys = new Set<string>();
	for (const id of ids) {
		if (matchByMessageId?.get(id) === "meaning") continue;
		const row = rowById.get(id);
		if (row) keys.add(rowConversationKey(row));
	}
	return keys.size;
}

/** Every message of each row's conversation (not just the ones a search matched), for `groupThreadMembers`. */
async function loadScopedThreads(
	db: AppDatabase,
	where: SQL | undefined,
	threadKey: SQL<string>,
	rows: readonly ListMessage[],
): Promise<ScopedThreads> {
	const keys = rows.map(rowConversationKey);
	if (keys.length === 0) return { ids: new Map(), unread: new Map(), inbound: new Map() };
	const members = await queryInChunks(keys, (chunk) =>
		db
			.select({ id: messages.id, key: threadKey, read: messages.read, direction: messages.direction })
			.from(messages)
			.where(and(where, inArray(threadKey, chunk))),
	);
	return groupThreadMembers(members);
}

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
	const { hybridIds, matchByMessageId, semanticStatus, semanticReason, keywordTotal } = await resolveListQuery({
		env,
		conditions,
		query,
		title,
		timeZone: getRequestTimeZone(request, user.timeZone),
		mailboxIds: mailboxScope.ids,
		tryHybrid: url.searchParams.get("semantic") !== "0" && !cursor,
		groupByThread,
	});
	const where = and(...conditions);
	// Messages that were never threaded (older rows, drafts) stand alone, and a conversation
	// never spans mailboxes: the same Message-ID delivered to two of them is two threads.
	const threadKey = conversationKey();

	// The list renders `snippet`. Bodies stay on the thread endpoint.
	const messageListColumns = getMessageListColumns();

	let total = 0;
	let rows: ListMessage[];
	let nextCursor: string | null = null;
	// How many of this page's rows (or thread rows) are a keyword match, for "Show all N keyword matches" below
	// (N-2 of review round 5): equal to `total` outside a hybrid page, where every row is one by definition.
	let keywordRowsShown = 0;
	// Which stored messages each visible row stands for, so acting on a
	// conversation row acts on the whole conversation within this folder.
	let scopedThreads: ScopedThreads = { ids: new Map(), unread: new Map(), inbound: new Map() };
	if (groupByThread && hybridIds) {
		// Hybrid results have no cursor, in conversation view too (N-1 of review round 4: a date cursor keyed on
		// the oldest of these relevance-ordered rows skipped most keyword matches newer than it, and the UI pager
		// then looped back to page one once that cursor ran out — an honest cap is correct, not a broken "more").
		// "Show all N keyword matches" (below) is the only way past it, by turning the chip off outright. The D1
		// re-check already applied `where`.
		const loaded = await queryInChunks(hybridIds, (ids) =>
			db.select(messageListColumns).from(messages).where(inArray(messages.id, ids)),
		);
		rows = representativeRowsByThread(hybridIds, loaded);
		total = rows.length;
		nextCursor = null;
		keywordRowsShown = keywordThreadCount(hybridIds, loaded, matchByMessageId);
		scopedThreads = await loadScopedThreads(db, where, threadKey, rows);
	} else if (groupByThread) {
		const page = await loadConversationPage({ db, where, offset, limit, cursor });
		total = page.total;
		// The ids already satisfy `where`; repeating it would only add bound parameters.
		rows = await queryInChunks(page.ids, (ids) =>
			db.select(messageListColumns).from(messages).where(inArray(messages.id, ids)),
		);
		const rowById = new Map(rows.map((row) => [row.id, row]));
		rows = page.ids.map((id) => rowById.get(id)).filter((row): row is ListMessage => !!row);
		nextCursor = getNextMessageCursor(rows, limit);
		keywordRowsShown = total;
		scopedThreads = await loadScopedThreads(db, where, threadKey, rows);
	} else if (hybridIds) {
		// The D1 re-check already applied `where`; repeating it would only add bound parameters. Hybrid results
		// have no cursor (N-1 of review round 4): an honest cap, not a cursor that silently skips most keyword
		// matches newer than whatever relevance put last on this page. "Show all N keyword matches" (below) is the
		// only way past it, by turning the chip off outright, which runs the ordinary date-ordered keyword path.
		const loaded = await queryInChunks(hybridIds, (ids) =>
			db.select(messageListColumns).from(messages).where(inArray(messages.id, ids)),
		);
		const rowById = new Map(loaded.map((row) => [row.id, row]));
		rows = hybridIds.map((id) => rowById.get(id)).filter((row): row is ListMessage => !!row);
		total = rows.length;
		nextCursor = null;
		keywordRowsShown = keywordRowCount(hybridIds, matchByMessageId);
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
		keywordRowsShown = total;
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
	// The connected account a row came in by, for its "via" chip.
	const via = await loadMessageVia(env, rows);
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
	const optionalRowFields = (messageId: string) => ({
		...(screenerPending.has(messageId) ? { screenerPending: true } : {}),
		...(sendStates.has(messageId) ? { sendState: sendStates.get(messageId) } : {}),
		...(via.has(messageId) ? { via: via.get(messageId) } : {}),
		...(matchByMessageId?.has(messageId) ? { match: matchByMessageId.get(messageId) } : {}),
	});
	const enrichedRows = rows.map(({ rawR2Key: _rawR2Key, ...message }) => {
		const contactMap = contactMapsByUserId.get(message.userId);
		const accountName = message.mailboxId ? mailboxNameMap.get(message.mailboxId) : null;
		const firstTo = getFirstEmailAddressEntry(message.toAddr);
		const key = rowConversationKey(message);
		const threadCount = message.threadId ? threadCounts.get(key) : undefined;
		return {
			...message,
			snippet: message.snippet,
			fromContactName:
				(message.direction === "outbound" ? accountName : null) ??
				getPartyDisplayName(message.fromAddr, contactMap?.get(normalizeEmailAddress(message.fromAddr))),
			toContactName: getPartyDisplayName(firstTo, contactMap?.get(normalizeEmailAddress(firstTo))),
			threadCount: threadCount?.total || 1,
			// A conversation row is unread only when a message it stands for in this folder is.
			threadUnread: (groupByThread ? scopedThreads.unread.get(key) : threadCount?.unread) || 0,
			hasAttachments: withAttachments.has(message.id),
			...rowSuggestions(message.id),
			...rowLines(message.id),
			...optionalRowFields(message.id),
			...(groupByThread
				? {
						threadMessageIds: scopedThreads.ids.get(key) ?? [message.id],
						threadInboundCount: scopedThreads.inbound.get(key) ?? 0,
					}
				: {}),
		};
	});

	return NextResponse.json({
		messages: enrichedRows,
		total,
		limit,
		offset,
		nextCursor,
		grouped: groupByThread,
		...(semanticStatus ? { semantic: semanticStatus, ...(semanticReason ? { semanticReason } : {}) } : {}),
		// "Show all N keyword matches" (N-1 of review round 4): only while the honest cap above actually left
		// keyword matches out, so the client knows both that there is more and how many, without a cursor that
		// would have to skip or repeat rows to get there. Compared against `keywordRowsShown`, not `total` (N-2 of
		// review round 5): `total` counts meaning-only rows too, so a page the cap filled with a mix of keyword and
		// meaning-only rows — not meaning-only rows alone — still left keyword matches out with nothing to show for it.
		...(keywordTotal !== undefined && keywordTotal > keywordRowsShown ? { keywordTotal } : {}),
	});
}
