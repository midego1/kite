import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { badgeView } from "@/lib/finance/views";
import { withModule } from "@/lib/modules/route-guard";

export const GET = withModule("finance", async (request, { checkUser }) => {
	const { user, error } = await requireSessionUser(getEnv(), request);
	if (error) return error;
	const denied = await checkUser(user);
	if (denied) return denied;
	return NextResponse.json(
		await badgeView({ userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin, timeZone: user.timeZone }),
	);
});
