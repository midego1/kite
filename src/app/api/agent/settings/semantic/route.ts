import { z } from "zod";
import { createLogger } from "@/lib/logger.mjs";
import { resolveManagedMailboxRequest } from "@/lib/mailboxes/managed-setting-route";
import { setMailboxSemanticIndex } from "@/lib/semantic/mailbox-settings";

const logger = createLogger("semantic-search");

const schema = z.object({ mailboxId: z.string().min(1).max(160), semanticIndex: z.boolean() });

/**
 * `{ mailboxId, semanticIndex }`: "Include this mailbox in search by meaning". Only someone who can manage the
 * mailbox may change it; it applies to everyone with access. Turning it off deletes the mailbox's vectors; turning
 * it on queues its eligible messages again.
 */
export async function PUT(request: Request) {
	const resolved = await resolveManagedMailboxRequest(request, schema);
	if ("error" in resolved) return resolved.error;
	const { env, user, access, data } = resolved;
	try {
		await setMailboxSemanticIndex(env, user, access, data.semanticIndex);
	} catch (error) {
		logger.error("semantic.mailbox_index_save_failed", { error: error instanceof Error ? error.name : "unknown" });
		return Response.json({ error: "Could not save this setting. Try again." }, { status: 500 });
	}
	return Response.json({ ok: true, semanticIndex: data.semanticIndex });
}
