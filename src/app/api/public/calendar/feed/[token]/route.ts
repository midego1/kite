import { allowCalendarFeedRequest, renderCalendarFeed, resolveCalendarFeed } from "@/lib/calendar/feed";
import { parseFeedTokenSegment } from "@/lib/calendar/feed-token-utils";
import { getEnv } from "@/lib/cloudflare";
import { withModule } from "@/lib/modules/route-guard";
import type { CalendarFeedTokenContext } from "./types";

/** Subscribing apps cannot sign in: the link is the credential, so nothing here may be cached, indexed or referred. */
const FEED_HEADERS = {
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
};

const notFound = () => new Response("Not found", { status: 404, headers: FEED_HEADERS });

/**
 * The read-only iCalendar feed behind a subscription link (`/api/public/calendar/feed/<token>.ics`). Google Calendar,
 * Outlook and Apple Calendar fetch a URL without headers, so the token is in the path; an unknown, revoked or
 * malformed token, a disabled owner and Calendar being off for the owner all answer the same 404.
 */
export const GET = withModule<CalendarFeedTokenContext>("calendar", async (_request, { params, checkHost }) => {
	const env = getEnv();
	const token = parseFeedTokenSegment((await params).token);
	if (!token) return notFound();
	if (!(await allowCalendarFeedRequest(env, token)))
		return new Response("Too many requests", { status: 429, headers: { ...FEED_HEADERS, "Retry-After": "60" } });
	const owner = await resolveCalendarFeed(env, token);
	if (!owner || (await checkHost(owner.userId))) return notFound();
	return new Response(await renderCalendarFeed(env, owner), {
		headers: {
			...FEED_HEADERS,
			"Content-Type": "text/calendar; charset=utf-8",
			"Content-Disposition": 'inline; filename="kite-calendar.ics"',
		},
	});
});
