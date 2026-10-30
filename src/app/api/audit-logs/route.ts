import { desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { auditLogs, domains, mailboxes, users } from "@/db/schema";
import { authorizeActivityRead } from "@/lib/auth/activity-access";
import { MODULE_AUDIT_ACTIONS } from "@/lib/modules/admin-utils";
import { TELEMETRY_AUDIT_ACTIONS } from "@/lib/telemetry/telemetry-utils";
import { MCP_TOOL_CALL_ACTION } from "@/lib/mcp/audit";

const LISTED_ACTIONS = ["auth.login", "auth.logout", ...MODULE_AUDIT_ACTIONS, ...TELEMETRY_AUDIT_ACTIONS];

export async function GET(request: Request) {
	const access = await authorizeActivityRead(request);
	if (access.error) return access.error;
	const { env, limit } = access;
	// MCP tool calls are one row each, so they are listed only when asked for and never crowd out the rest.
	const mcpCalls = new URL(request.url).searchParams.get("action") === MCP_TOOL_CALL_ACTION;
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
		.where(mcpCalls ? eq(auditLogs.action, MCP_TOOL_CALL_ACTION) : inArray(auditLogs.action, LISTED_ACTIONS))
		.orderBy(desc(auditLogs.createdAt))
		.limit(limit);

	return NextResponse.json({ auditLogs: rows });
}
