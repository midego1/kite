import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import type { SessionUser } from "@/lib/auth/types";
import { undoLatestSpamReceipt } from "@/lib/spam/report-receipts";
import { updateMessageStatusForUser } from "@/lib/user";
import { AgentActionError } from "./action-error";
import type { ActionEffect, AgentActionRow } from "./actions-types";
import { parseActionState } from "./actions-utils";
import { notifySuggestionsQuietly } from "./suggestion-events";

async function messageState(env: CloudflareEnv, messageId: string) {
	const [row] = await getDb(env)
		.select({ status: messages.status, folderId: messages.folderId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	return row ?? null;
}

/** "Mark as spam" on a phishing warning: moves the message to Spam and closes the suggestion as accepted. */
export async function markSpamEffect(
	env: CloudflareEnv,
	user: SessionUser,
	suggestion: { id: string; messageId: string },
): Promise<ActionEffect> {
	const before = await messageState(env, suggestion.messageId);
	if (!before) throw new AgentActionError("Message not found", 404);
	return {
		before,
		async apply() {
			if (!(await updateMessageStatusForUser(env, user, suggestion.messageId, "spam")))
				throw new Error("The message could not be moved to Spam");
			await getDb(env)
				.update(agentSuggestions)
				.set({ status: "accepted", decidedAt: new Date(), decidedByUserId: user.id })
				.where(eq(agentSuggestions.id, suggestion.id));
			return { status: "spam" };
		},
		async check() {
			return (await messageState(env, suggestion.messageId))?.status === "spam" ? { status: "spam" } : null;
		},
	};
}

/** Undo of "Mark as spam": puts the message back where it was and reopens the warning. */
export async function restoreMarkedSpam(env: CloudflareEnv, row: AgentActionRow): Promise<void> {
	const before = parseActionState(row.before);
	if (!row.messageId || typeof before?.status !== "string") return;
	const db = getDb(env);
	const restored = await db
		.update(messages)
		.set({ status: before.status, folderId: typeof before.folderId === "string" ? before.folderId : null })
		.where(and(eq(messages.id, row.messageId), eq(messages.status, "spam")))
		.returning({ id: messages.id });
	if (restored.length === 0) throw new AgentActionError("The message was moved again, so Kite left it", 409);
	await undoLatestSpamReceipt(env, row.messageId, "to_spam", row.createdAt);
	if (!row.suggestionId) return;
	await db
		.update(agentSuggestions)
		.set({ status: "open", decidedAt: null, decidedByUserId: null })
		.where(and(eq(agentSuggestions.id, row.suggestionId), eq(agentSuggestions.status, "accepted")));
	await notifySuggestionsQuietly(env, [row.suggestionId]);
}
