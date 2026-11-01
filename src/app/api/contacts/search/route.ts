import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { contactLikePattern, normalizeContactQuery, parseContactSearchLimit, toContactSearchHit } from "./search-utils";

/**
 * The signed-in user's own contacts whose name or address contains `q`, most recently seen first, for the
 * command palette. `total` counts every match so the palette can show how many there are beyond `limit`.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const params = new URL(request.url).searchParams;
	const query = normalizeContactQuery(params.get("q"));
	if (!query) return NextResponse.json({ contacts: [], total: 0 });
	const limit = parseContactSearchLimit(params.get("limit"));
	const pattern = contactLikePattern(query);
	const where = and(
		eq(contacts.userId, user.id),
		or(sql`${contacts.email} LIKE ${pattern} ESCAPE '\\'`, sql`${contacts.displayName} LIKE ${pattern} ESCAPE '\\'`),
	);
	const db = getDb(env);
	const [rows, [counted]] = await Promise.all([
		db
			.select({
				email: contacts.email,
				displayName: contacts.displayName,
				avatarKey: contacts.avatarKey,
				blocked: contacts.blocked,
				lastSeenAt: contacts.lastSeenAt,
			})
			.from(contacts)
			.where(where)
			.orderBy(desc(contacts.lastSeenAt), contacts.email)
			.limit(limit),
		db.select({ total: count() }).from(contacts).where(where),
	]);
	return NextResponse.json({ contacts: rows.map(toContactSearchHit), total: counted?.total ?? rows.length });
}
