import { and, desc, eq, gte, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, calendarEvents, users } from "@/db/schema";
import { timingSafeEqual } from "@/lib/auth/totp";
import { createLogger } from "@/lib/logger.mjs";
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
/** A bound on one response; past it the oldest one-off events are the ones left out (`calendar.feed_truncated`). */
const FEED_MAX_EVENTS = 5000;
const log = createLogger("calendar");

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
		// Running series first, then one-off events newest first, so a cap never drops what is coming up.
		.orderBy(sql`case when ${calendarEvents.repeat} = 'none' then 1 else 0 end`, desc(calendarEvents.startsAt))
		.limit(FEED_MAX_EVENTS + 1);
	if (events.length > FEED_MAX_EVENTS) {
		log.warn("calendar.feed_truncated", { userId: owner.userId, limit: FEED_MAX_EVENTS });
		events.length = FEED_MAX_EVENTS;
	}
	return buildCalendarFeed(events, { name: "Kite calendar", timeZone: owner.timeZone, now });
}

async function allow(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return true;
	try {
		return (await limiter.limit({ key })).success;
	} catch (error) {
		console.warn("Calendar feed rate limiter unavailable", error);
		return true;
	}
}

/**
 * Two budgets. Per address, on the public-link limiter (60 a minute, the budget Drive's public links have): it bounds
 * all traffic to the route, since the token in the path is the caller's choice. Per link, on the login limiter (20 a
 * minute): one link polled too often is stopped without blocking the others a calendar service fetches from the
 * same address.
 */
export async function allowCalendarFeedRequest(env: CloudflareEnv, request: Request, token: string): Promise<boolean> {
	const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
	return (
		(await allow(env.DRIVE_LINK_RATE_LIMIT, `calendar-feed:${ip}`)) &&
		(await allow(env.LOGIN_RATE_LIMIT, `calendar-feed:${feedTokenPrefix(token)}`))
	);
}
