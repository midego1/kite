import { z } from "zod";
import { setMailboxAiDisabled } from "@/lib/agent/mailbox-ai-settings";
import { createLogger } from "@/lib/logger.mjs";
import { resolveManagedMailboxRequest } from "@/lib/mailboxes/managed-setting-route";

const logger = createLogger("agent");

const schema = z.object({ mailboxId: z.string().min(1).max(160), aiDisabled: z.boolean() });

/**
 * `{ mailboxId, aiDisabled }`: "No AI for this mailbox". Only someone who can manage the mailbox may change it (403
 * otherwise); it applies to everyone with access. Before migration 0091 the answer is 409 `MIGRATION_PENDING`.
 * Turning it on calls no model: it stops queued jobs and removes suggestions and summaries.
 */
export async function PUT(request: Request) {
	const resolved = await resolveManagedMailboxRequest(request, schema);
	if ("error" in resolved) return resolved.error;
	const { env, user, access, data } = resolved;
	let outcome: Awaited<ReturnType<typeof setMailboxAiDisabled>>;
	try {
		outcome = await setMailboxAiDisabled(env, user, access, data.aiDisabled);
	} catch (error) {
		logger.error("agent.mailbox_ai_save_failed", { error: error instanceof Error ? error.name : "unknown" });
		return Response.json({ error: "Could not save this setting. Try again." }, { status: 500 });
	}
	if (outcome === "migration_pending")
		return Response.json(
			{ error: "Apply the pending database update to change this setting", code: "MIGRATION_PENDING" },
			{ status: 409 },
		);
	return Response.json({ ok: true, aiDisabled: data.aiDisabled });
}
