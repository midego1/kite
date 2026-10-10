import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { listAgentActivity } from "@/lib/agent/auto-read/activity";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	// The audit log is for full-access users only; everyone else cannot tell the mailbox has one.
	if (!mailboxId || !(await getMailboxAccessLevel(getDb(env), user, mailboxId))?.canManage)
		return Response.json({ error: "Mailbox not found" }, { status: 404 });
	return Response.json(await listAgentActivity(env, mailboxId));
}
