import { z } from "zod";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { setMailboxAiDisabled } from "@/lib/agent/mailbox-ai-settings";
import { readJsonBody } from "@/lib/http/request";
import { createLogger } from "@/lib/logger.mjs";

const logger = createLogger("agent");

const schema = z.object({ mailboxId: z.string().min(1).max(160), aiDisabled: z.boolean() });

/**
 * `{ mailboxId, aiDisabled }`: "No AI for this mailbox". Only someone who can manage the mailbox may change it (403
 * otherwise); it applies to everyone with access. Before migration 0091 the answer is 409 `MIGRATION_PENDING`.
 * Turning it on calls no model: it stops queued jobs and removes suggestions and summaries.
 */
export async function PUT(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = schema.safeParse(await readJsonBody(request, 2_000).catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
	const access = await getMailboxAccessLevel(getDb(env), user, parsed.data.mailboxId);
	if (!access?.canManage) return Response.json({ error: "Mailbox not found or permission denied" }, { status: 403 });
	let outcome: Awaited<ReturnType<typeof setMailboxAiDisabled>>;
	try {
		outcome = await setMailboxAiDisabled(env, user, access, parsed.data.aiDisabled);
	} catch (error) {
		logger.error("agent.mailbox_ai_save_failed", { error: error instanceof Error ? error.name : "unknown" });
		return Response.json({ error: "Could not save this setting. Try again." }, { status: 500 });
	}
	if (outcome === "migration_pending")
		return Response.json(
			{ error: "Apply the pending database update to change this setting", code: "MIGRATION_PENDING" },
			{ status: 409 },
		);
	return Response.json({ ok: true, aiDisabled: parsed.data.aiDisabled });
}
