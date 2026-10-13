import { desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { auditLogs, domains, mailboxes, users } from "@/db/schema";
import { authorizeActivityRead } from "@/lib/auth/activity-access";
import { MODULE_AUDIT_ACTIONS } from "@/lib/modules/admin-utils";

export async function GET(request: Request) {
	const access = await authorizeActivityRead(request);
	if (access.error) return access.error;
	const { env, limit } = access;
	const db = getDb(env);
	const targetUsers = alias(users, "target_users");
	const rows = await db
		.select({
			id: auditLogs.id,
			action: auditLogs.action,
			metadata: auditLogs.metadata,
			createdAt: auditLogs.createdAt,
			actorEmail: users.email,
			targetEmail: targetUsers.email,
			mailboxLocalPart: mailboxes.localPart,
			mailboxHostname: domains.hostname,
		})
		.from(auditLogs)
		.leftJoin(users, eq(users.id, auditLogs.actorUserId))
		.leftJoin(targetUsers, eq(targetUsers.id, auditLogs.targetUserId))
		.leftJoin(mailboxes, eq(mailboxes.id, auditLogs.mailboxId))
		.leftJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(inArray(auditLogs.action, ["auth.login", "auth.logout", ...MODULE_AUDIT_ACTIONS]))
		.orderBy(desc(auditLogs.createdAt))
		.limit(limit);

	return NextResponse.json({ auditLogs: rows });
}
