import { and, asc, eq, gte, isNull, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, calendarEvents, users } from "@/db/schema";
import { timingSafeEqual } from "@/lib/auth/totp";
import { newId } from "@/lib/ids";
import { normalizeTimeZone } from "@/lib/time/utils";
import { buildCalendarFeed } from "./feed-utils";
import { feedTokenPrefix, generateFeedToken, hashFeedToken } from "./feed-token-utils";
import type { CalendarFeedStatus } from "./feed-types";

/**
 * A subscription link is an `api_keys` row of kind `calendar_feed`: its own credential, revoked or replaced from the
 * calendar, that `authenticateApiKeyValue` never accepts, so it opens the feed and nothing else. It stores the
 * token's SHA-256 (the token has ~190 bits, so a slow hash adds nothing) and its scope is always `calendar:read`.
 */
const FEED_KIND = "calendar_feed";
const FEED_SCOPES = JSON.stringify(["calendar:read"]);
const FEED_NAME = "Calendar subscription";
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
/** Older events are left out of the feed so a long-lived calendar stays a reasonable download. */
const FEED_HISTORY_MS = 365 * 86_400_000;
const FEED_MAX_EVENTS = 5000;

export async function getCalendarFeedStatus(env: CloudflareEnv, userId: string): Promise<CalendarFeedStatus> {
	const [row] = await getDb(env)
		.select({ createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt })
		.from(apiKeys)
		.where(and(eq(apiKeys.userId, userId), eq(apiKeys.kind, FEED_KIND)))
		.limit(1);
	return {
		active: !!row,
		createdAt: row?.createdAt.toISOString() ?? null,
		lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
	};
}

/** Replaces the owner's subscription link (one per user) and returns the new token, which is never stored. */
export async function rotateCalendarFeed(env: CloudflareEnv, userId: string): Promise<string> {
	const token = generateFeedToken();
	const db = getDb(env);
	// One batch, so two clicks at once still leave a single link.
	await db.batch([
		db.delete(apiKeys).where(and(eq(apiKeys.userId, userId), eq(apiKeys.kind, FEED_KIND))),
		db.insert(apiKeys).values({
			id: newId(),
			kind: FEED_KIND,
			userId,
			name: FEED_NAME,
			prefix: feedTokenPrefix(token),
			keyHash: await hashFeedToken(token),
			scopes: FEED_SCOPES,
		}),
	]);
	return token;
}

export async function revokeCalendarFeed(env: CloudflareEnv, userId: string): Promise<void> {
	await getDb(env)
		.delete(apiKeys)
		.where(and(eq(apiKeys.userId, userId), eq(apiKeys.kind, FEED_KIND)));
}

/** The active owner of a subscription token, or `null`. The hash is compared in constant time. */
export async function resolveCalendarFeed(
	env: CloudflareEnv,
	token: string,
): Promise<{ userId: string; role: string; isPrimaryAdmin: boolean; timeZone: string } | null> {
	const db = getDb(env);
	const hash = await hashFeedToken(token);
	const candidates = await db
		.select({ id: apiKeys.id, userId: apiKeys.userId, keyHash: apiKeys.keyHash, lastUsedAt: apiKeys.lastUsedAt })
		.from(apiKeys)
		.where(and(eq(apiKeys.prefix, feedTokenPrefix(token)), eq(apiKeys.kind, FEED_KIND)));
	const match = candidates.find((candidate) => timingSafeEqual(candidate.keyHash, hash));
	if (!match) return null;
	const [user] = await db
		.select({
			role: users.role,
			isPrimaryAdmin: users.isPrimaryAdmin,
			disabled: users.disabled,
			timeZone: users.timeZone,
		})
		.from(users)
		.where(eq(users.id, match.userId))
		.limit(1);
	if (!user || user.disabled) return null;
	if (!match.lastUsedAt || match.lastUsedAt.getTime() < Date.now() - LAST_USED_WRITE_INTERVAL_MS)
		await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, match.id));
	return {
		userId: match.userId,
		role: user.role,
		isPrimaryAdmin: user.isPrimaryAdmin,
		timeZone: normalizeTimeZone(user.timeZone),
	};
}

/** The owner's events from the last year on, plus every series still running then, as one iCalendar document. */
export async function renderCalendarFeed(
	env: CloudflareEnv,
	owner: { userId: string; timeZone: string },
	now = new Date(),
): Promise<string> {
	const since = new Date(now.getTime() - FEED_HISTORY_MS);
	const events = await getDb(env)
		.select()
		.from(calendarEvents)
		.where(
			and(
				eq(calendarEvents.userId, owner.userId),
				or(
					gte(calendarEvents.endsAt, since),
					and(
						ne(calendarEvents.repeat, "none"),
						or(isNull(calendarEvents.repeatUntil), gte(calendarEvents.repeatUntil, since)),
					),
				),
			),
		)
		.orderBy(asc(calendarEvents.startsAt))
		.limit(FEED_MAX_EVENTS);
	return buildCalendarFeed(events, { name: "Kite calendar", timeZone: owner.timeZone, now });
}

/** Calendar apps poll from shared addresses, so the budget is per link rather than per IP. */
export async function allowCalendarFeedRequest(env: CloudflareEnv, token: string): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `calendar-feed:${feedTokenPrefix(token)}` })).success;
	} catch (error) {
		console.warn("Calendar feed rate limiter unavailable", error);
		return true;
	}
}
