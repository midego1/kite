import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentJobs } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { agentJobQueueMessage } from "@/lib/agent/queue-utils";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	const db = getDb(env);
	const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, id)).limit(1);
	const access = job && (await getMailboxAccessLevel(db, user, job.mailboxId));
	// Triage only reads mail, so its reviewer needs read access; a draft job needs send-on-behalf.
	if (!job || job.reviewerUserId !== user.id || !(job.kind === "triage" ? access?.canRead : access?.canSendOnBehalf))
		return Response.json({ error: "Job not found" }, { status: 404 });
	if (job.status !== "failed") return Response.json({ error: "Job cannot be retried" }, { status: 409 });
	await db
		.update(agentJobs)
		.set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), leaseUntil: null, reason: null })
		.where(and(eq(agentJobs.id, id), eq(agentJobs.status, "failed")));
	await env.AGENT_QUEUE?.send(agentJobQueueMessage(job.kind, id));
	return Response.json({ ok: true });
}
