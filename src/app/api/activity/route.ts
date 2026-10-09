import { desc, inArray, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getEnv } from "@/lib/cloudflare";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;

	const url = new URL(request.url);
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 200);
	const rows = await getDb(env)
		.select({
			id: auditLogs.id,
			action: auditLogs.action,
			metadata: auditLogs.metadata,
			createdAt: auditLogs.createdAt,
			actorEmail: users.email,
		})
		.from(auditLogs)
		.leftJoin(users, eq(users.id, auditLogs.actorUserId))
		.where(inArray(auditLogs.action, ["auth.login", "auth.logout"]))
		.orderBy(desc(auditLogs.createdAt))
		.limit(limit);

	return NextResponse.json({ activities: rows });
}
