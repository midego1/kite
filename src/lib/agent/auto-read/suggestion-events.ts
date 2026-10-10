import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxAccess, mailboxes } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import { notifyUsersOfNewMessage } from "@/lib/realtime/utils";

/** The owner plus every full-access sharer; read-only and send-on-behalf sharers never see suggestions. */
async function listFullAccessUserIds(env: CloudflareEnv, mailboxId: string): Promise<string[]> {
	const db = getDb(env);
	const [mailbox] = await db
		.select({ userId: mailboxes.userId, type: mailboxes.type, disabled: mailboxes.disabled })
		.from(mailboxes)
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	if (!mailbox || mailbox.disabled) return [];
	const sharers =
		mailbox.type === "shared"
			? await db
					.select({ userId: mailboxAccess.userId })
					.from(mailboxAccess)
					.where(and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.permission, "full_access")))
			: [];
	return [...new Set([mailbox.userId, ...sharers.map((row) => row.userId)])];
}

/** Sends an `agent_suggestion` event per suggestion to the users with full access on its mailbox. */
async function notifySuggestionsChanged(env: CloudflareEnv, suggestionIds: string[]): Promise<void> {
	const ids = [...new Set(suggestionIds)];
	if (ids.length === 0 || !env.REALTIME) return;
	const rows = await getDb(env)
		.select({
			id: agentSuggestions.id,
			mailboxId: agentSuggestions.mailboxId,
			messageId: agentSuggestions.messageId,
			kind: agentSuggestions.kind,
		})
		.from(agentSuggestions)
		.where(inArray(agentSuggestions.id, ids));
	const recipients = new Map<string, string[]>();
	for (const row of rows) {
		const userIds = recipients.get(row.mailboxId) ?? (await listFullAccessUserIds(env, row.mailboxId));
		recipients.set(row.mailboxId, userIds);
		await notifyUsersOfNewMessage(env, userIds, {
			type: "agent_suggestion",
			mailboxId: row.mailboxId,
			messageId: row.messageId,
			suggestionId: row.id,
			kind: row.kind,
		});
	}
}

/** Notifies best-effort: a realtime failure must never undo or fail the suggestion change itself. */
export async function notifySuggestionsQuietly(env: CloudflareEnv, suggestionIds: string[]): Promise<void> {
	try {
		await notifySuggestionsChanged(env, suggestionIds);
	} catch (error) {
		console.warn("agent.suggestion_notify_failed", error instanceof Error ? error.message : error);
	}
}
