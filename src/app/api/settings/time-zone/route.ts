import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { emitLifecycleEvent } from "@/lib/modules/lifecycle";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { parseTimeZoneUpdate } from "./utils";
import { getRequestTimeZone } from "@/lib/time/utils";

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const input = await parseTimeZoneUpdate(request);
	if (!input) return NextResponse.json({ error: "Choose a valid timezone" }, { status: 400 });
	const db = getDb(env);
	// A cleared preference means the device's zone, so both ends name the zone the account is read in.
	// Calendar freezes legacy series in `from` before the preference moves.
	await emitLifecycleEvent({
		type: "user.time_zone_changed",
		userId: user.id,
		from: getRequestTimeZone(request, user.timeZone),
		to: getRequestTimeZone(request, input.timeZone),
	});
	await db.update(users).set({ timeZone: input.timeZone }).where(eq(users.id, user.id));
	return NextResponse.json({ timeZone: input.timeZone });
}
