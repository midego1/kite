import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getCalendarFeedStatus, revokeCalendarFeed, rotateCalendarFeed } from "@/lib/calendar/feed";
import { calendarFeedPath } from "@/lib/calendar/feed-token-utils";
import { getEnv } from "@/lib/cloudflare";
import { withModule } from "@/lib/modules/route-guard";

/** Whether the signed-in user has a subscription link. The link itself cannot be shown again, only replaced. */
export const GET = withModule("calendar", async (request, { checkAuth }) => {
	const env = getEnv();
	const { user, error } = await checkAuth(requireSessionUser(env, request));
	if (error) return error;
	return NextResponse.json({ feed: await getCalendarFeedStatus(env, user.id) });
});

/** Creates the subscription link, or replaces it: the previous link stops working at once. */
export const POST = withModule("calendar", async (request, { checkAuth }) => {
	const env = getEnv();
	const { user, error } = await checkAuth(requireSessionUser(env, request));
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const token = await rotateCalendarFeed(env, user.id);
	return NextResponse.json(
		{ path: calendarFeedPath(token), feed: await getCalendarFeedStatus(env, user.id) },
		{ headers: { "Cache-Control": "no-store" } },
	);
});

/** Turns the subscription link off. */
export const DELETE = withModule("calendar", async (request, { checkAuth }) => {
	const env = getEnv();
	const { user, error } = await checkAuth(requireSessionUser(env, request));
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	await revokeCalendarFeed(env, user.id);
	return NextResponse.json({ feed: await getCalendarFeedStatus(env, user.id) });
});
