import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { subscriptionDetailView } from "@/lib/finance/views";
import { withModule } from "@/lib/modules/route-guard";
import type { SubscriptionRouteContext } from "./types";

export const GET = withModule<SubscriptionRouteContext>("finance", async (request, { params, checkUser }) => {
	const { user, error } = await requireSessionUser(getEnv(), request);
	if (error) return error;
	const denied = await checkUser(user);
	if (denied) return denied;
	const { id } = await params;
	const detail = await subscriptionDetailView(
		{ userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin, timeZone: user.timeZone },
		id,
	);
	if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json(detail);
});
