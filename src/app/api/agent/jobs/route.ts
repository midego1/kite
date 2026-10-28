import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { agentJobs } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	// One-line summary jobs skip routinely (short mail, newsletters), so they are listed only when asked for and
	// never crowd real draft and triage failures out of the 30 rows.
	const kind =
		url.searchParams.get("kind") === "line_summary"
			? eq(agentJobs.kind, "line_summary")
			: ne(agentJobs.kind, "line_summary");
	if (!mailboxId || !(await getMailboxAccessLevel(getDb(env), user, mailboxId))?.canRead)
		return Response.json({ error: "Mailbox not found" }, { status: 404 });
	const rows = await getDb(env)
		.select({
			id: agentJobs.id,
			kind: agentJobs.kind,
			status: agentJobs.status,
			reason: agentJobs.reason,
			draftId: agentJobs.draftId,
			sourceMessageId: agentJobs.sourceMessageId,
			createdAt: agentJobs.createdAt,
		})
		.from(agentJobs)
		.where(and(eq(agentJobs.mailboxId, mailboxId), eq(agentJobs.reviewerUserId, user.id), kind))
		.orderBy(desc(agentJobs.createdAt))
		.limit(30);
	return Response.json({ jobs: rows });
}
