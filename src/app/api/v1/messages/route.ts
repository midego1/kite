import { NextResponse } from "next/server";
import { eq, desc, and, inArray, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { getDb } from "@/db";
import { messages, users } from "@/db/schema";
import { queryInChunks } from "@/db/chunk-utils";
import { messageColumnsWithoutBodies, withStoredBodies } from "@/lib/messages/body-batches";
import { loadMessageBodies } from "@/lib/email/bodies";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { buildSearchConditions } from "@/lib/search/conditions";
import { parseSearchQuery } from "@/lib/search/query-utils";
import { viaSearchAvailable } from "@/lib/external-accounts/via";
import { getRequestTimeZone } from "@/lib/time/utils";
import { decodeMessageCursor, getNextMessageCursor } from "@/lib/messages/cursor-utils";
import { afterCursor } from "@/app/api/messages/utils";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import { mailboxRowsCondition, visibleDraftsCondition } from "@/lib/messages/mailbox-scope";
import { semanticSearch } from "@/lib/semantic/search";
import type { AppDatabase } from "@/db";
import type { SessionUser } from "@/lib/auth/types";

type MailboxScope =
	| { kind: "scope"; conditions: SQL[]; vectorMailboxIds: string[] }
	| { kind: "empty" }
	| { kind: "error"; response: NextResponse };

/** Resolves `mailboxId` (or every accessible mailbox) into scope conditions and the ids a hybrid search is scoped to. */
async function resolveMailboxScope(
	db: AppDatabase,
	user: SessionUser,
	auth: { userId: string; mailboxIds: string[] | null },
	mailboxId: string | null,
): Promise<MailboxScope> {
	const notFound = () => ({
		kind: "error" as const,
		response: NextResponse.json({ error: "Mailbox not found" }, { status: 404 }),
	});
	if (mailboxId) {
		if (auth.mailboxIds && !auth.mailboxIds.includes(mailboxId)) return notFound();
		const access = await getMailboxAccessLevel(db, user, mailboxId);
		if (!access?.canRead) return notFound();
		return { kind: "scope", conditions: [eq(messages.mailboxId, mailboxId)], vectorMailboxIds: [mailboxId] };
	}
	const accessibleMailboxIds = (await listAccessibleMailboxIds(db, user)).filter(
		(id) => !auth.mailboxIds || auth.mailboxIds.includes(id),
	);
	if (accessibleMailboxIds.length > 0)
		return {
			kind: "scope",
			conditions: [mailboxRowsCondition(accessibleMailboxIds, auth.userId)],
			vectorMailboxIds: accessibleMailboxIds,
		};
	if (auth.mailboxIds) return { kind: "empty" };
	return { kind: "scope", conditions: [eq(messages.userId, auth.userId)], vectorMailboxIds: [] };
}

type QueryResolution = {
	conditions: SQL[];
	hybridIds: string[] | null;
	semantic?: "on" | "off" | "unavailable";
	semanticReason?: string;
};

/** `mode=hybrid`: tries meaning (fused with keyword) unless there is a cursor (hybrid results have no cursor) or no
 * free text; falls back to the ordinary keyword conditions whenever it is not tried or is unavailable. */
async function resolveQuery(
	env: CloudflareEnv,
	scope: SQL[],
	vectorMailboxIds: string[],
	query: string,
	timeZone: string,
	mode: string | null,
	hasCursor: boolean,
): Promise<QueryResolution> {
	const connectedAccounts = await viaSearchAvailable(env, query);
	const parsed = parseSearchQuery(query, timeZone);
	const tryHybrid = mode === "hybrid" && !hasCursor && parsed.text.trim().length > 0;
	if (tryHybrid) {
		const operatorConditions = buildSearchConditions(query, timeZone, { connectedAccounts, includeFullText: false });
		const result = await semanticSearch({
			env,
			scopeWhere: and(...scope, ...operatorConditions)!,
			queryText: parsed.text,
			mailboxIds: vectorMailboxIds,
		});
		if (result.semantic === "on") return { conditions: [], hybridIds: result.ids, semantic: "on" };
		// "off" (feature or assistant off, or too short to embed) and "unavailable" (a real failure) both fall back
		// to the ordinary keyword conditions (operators and free text together); only "unavailable" names a reason
		// (C-1 of review round 3, same distinction `/api/messages` makes).
		return {
			conditions: buildSearchConditions(query, timeZone, { connectedAccounts }),
			hybridIds: null,
			semantic: result.semantic,
			semanticReason: result.semanticReason,
		};
	}
	return { conditions: buildSearchConditions(query, timeZone, { connectedAccounts }), hybridIds: null };
}

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateApiKey(env, request.headers.get("authorization"));
	if (!auth || !requireScope(auth.scopes, "read")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const direction = url.searchParams.get("direction");
	const query = url.searchParams.get("q")?.trim();
	const mode = url.searchParams.get("mode");
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
	const cursorParam = url.searchParams.get("cursor");
	const cursor = decodeMessageCursor(cursorParam);
	if (cursorParam && !cursor) {
		return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
	}

	const db = getDb(env);
	const [user] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
	if (!user || user.disabled) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const scope = await resolveMailboxScope(db, user, auth, mailboxId);
	if (scope.kind === "error") return scope.response;
	if (scope.kind === "empty") return NextResponse.json({ messages: [] });
	// Mail held in the Screener stays out of the API until its sender is approved, and other users' drafts always.
	const conditions: SQL[] = [
		ne(messages.status, SCREENING_STATUS),
		visibleDraftsCondition(auth.userId),
		...scope.conditions,
	];
	if (direction === "inbound" || direction === "outbound") {
		conditions.push(eq(messages.direction, direction));
	}

	const timeZone = getRequestTimeZone(request, user.timeZone);
	let hybridIds: string[] | null = null;
	let semantic: "on" | "off" | "unavailable" | undefined;
	let semanticReason: string | undefined;
	if (query) {
		const resolved = await resolveQuery(env, conditions, scope.vectorMailboxIds, query, timeZone, mode, !!cursor);
		conditions.push(...resolved.conditions);
		hybridIds = resolved.hybridIds;
		semantic = resolved.semantic;
		semanticReason = resolved.semanticReason;
	}
	if (cursor) conditions.push(afterCursor(messages.createdAt, messages.id, cursor));

	if (hybridIds) {
		const loaded = await queryInChunks(hybridIds, (chunk) =>
			db
				.select(messageColumnsWithoutBodies)
				.from(messages)
				.where(and(...conditions, inArray(messages.id, chunk))),
		);
		const byId = new Map(loaded.map((row) => [row.id, row]));
		const ordered = hybridIds
			.map((id) => byId.get(id))
			.filter((row): row is (typeof loaded)[number] => !!row)
			.slice(0, limit);
		const rows = await loadMessageBodies(env, await withStoredBodies(db, ordered));
		// Hybrid results have no cursor; "Show more" continues with keyword results by date.
		return NextResponse.json({ messages: rows, nextCursor: null, semantic, semanticReason });
	}

	const rows = await loadMessageBodies(
		env,
		// Bodies in bounded batches: 100 messages of up to 0.5 MB each would pass D1's 50 MB result limit.
		await withStoredBodies(
			db,
			await db
				.select(messageColumnsWithoutBodies)
				.from(messages)
				.where(and(...conditions))
				.orderBy(desc(messages.createdAt), desc(messages.id))
				.limit(limit),
		),
	);

	return NextResponse.json({
		messages: rows,
		nextCursor: getNextMessageCursor(rows, limit),
		...(mode === "hybrid" && query ? { semantic: semantic ?? "off", semanticReason } : {}),
	});
}
