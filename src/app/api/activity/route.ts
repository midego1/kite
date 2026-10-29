import { desc, inArray, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { authorizeActivityRead } from "@/lib/auth/activity-access";
import { MODULE_AUDIT_ACTIONS } from "@/lib/modules/admin-utils";
import { TELEMETRY_AUDIT_ACTIONS } from "@/lib/telemetry/telemetry-utils";
import { AGENT_PROVIDER_AUDIT_ACTIONS } from "@/lib/agent/provider-constants";

export async function GET(request: Request) {
	const access = await authorizeActivityRead(request);
	if (access.error) return access.error;
	const { env, limit } = access;
	const targetUsers = alias(users, "target_users");
	const rows = await getDb(env)
		.select({
			id: auditLogs.id,
			action: auditLogs.action,
			metadata: auditLogs.metadata,
			createdAt: auditLogs.createdAt,
			actorEmail: users.email,
			targetEmail: targetUsers.email,
		})
		.from(auditLogs)
		.leftJoin(users, eq(users.id, auditLogs.actorUserId))
		.leftJoin(targetUsers, eq(targetUsers.id, auditLogs.targetUserId))
		.where(
			inArray(auditLogs.action, [
				"auth.login",
				"auth.logout",
				...MODULE_AUDIT_ACTIONS,
				...TELEMETRY_AUDIT_ACTIONS,
				...AGENT_PROVIDER_AUDIT_ACTIONS,
			]),
		)
		.orderBy(desc(auditLogs.createdAt))
		.limit(limit);

	return NextResponse.json({ activities: rows });
}
