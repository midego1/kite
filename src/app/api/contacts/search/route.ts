import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, type AppDatabase } from "@/db";
import { contacts, messages } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { SCREENING_STATUS, screenerAddress } from "@/lib/screener/screener-utils";
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
	const held = await heldSenders(
		db,
		user.id,
		rows.map((row) => row.email),
	);
	return NextResponse.json({
		contacts: rows.map((row) => toContactSearchHit(row, held)),
		total: counted?.total ?? rows.length,
	});
}

/** Of these addresses, the ones the Screener still holds mail from in the user's own mailboxes. */
async function heldSenders(db: AppDatabase, userId: string, emails: readonly string[]): Promise<Set<string>> {
	if (emails.length === 0) return new Set();
	const wanted = new Set(emails);
	// The From header keeps its display name, so the rows are narrowed by address in SQL and settled exactly here.
	const rows = await db
		.select({ fromAddr: messages.fromAddr })
		.from(messages)
		.where(
			and(
				eq(messages.userId, userId),
				eq(messages.status, SCREENING_STATUS),
				or(
					...emails.map(
						(email) => sql`lower(${messages.fromAddr}) LIKE ${contactLikePattern(email.toLowerCase())} ESCAPE '\\'`,
					),
				),
			),
		)
		.limit(200);
	const held = new Set<string>();
	for (const row of rows) {
		const address = screenerAddress(row.fromAddr);
		if (address && wanted.has(address)) held.add(address);
	}
	return held;
}
