import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import { notifySuggestionsQuietly } from "./suggestion-events";
import { SUGGESTION_EXPIRY_DAYS } from "./suggestion-utils";

const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * A later message in the same mailbox and thread: any inbound mail, or a reply that was actually sent.
 * Timestamps are whole seconds, so rowid orders two messages stored within the same second.
 */
const NEWER_THREAD_MESSAGE = sql`EXISTS (
	SELECT 1 FROM messages AS source, messages AS later
	WHERE source.id = agent_suggestions.message_id
		AND later.mailbox_id = agent_suggestions.mailbox_id
		AND later.thread_id = agent_suggestions.thread_id
		AND later.id <> source.id
		AND (later.created_at > source.created_at OR (later.created_at = source.created_at AND later.rowid > source.rowid))
		AND (later.direction = 'inbound' OR (later.direction = 'outbound' AND later.status = 'sent'))
)`;

/**
 * Marks open reply suggestions in the thread `superseded` when a newer inbound message or a sent reply
 * follows their message. Returns the ids it closed.
 */
export async function supersedeThreadReplies(
	env: CloudflareEnv,
	mailboxId: string,
	threadId: string | null,
	now = new Date(),
): Promise<string[]> {
	if (!threadId) return [];
	const closed = await getDb(env)
		.update(agentSuggestions)
		.set({ status: "superseded", decidedAt: now })
		.where(
			and(
				eq(agentSuggestions.mailboxId, mailboxId),
				eq(agentSuggestions.threadId, threadId),
				eq(agentSuggestions.kind, "reply"),
				eq(agentSuggestions.status, "open"),
				NEWER_THREAD_MESSAGE,
			),
		)
		.returning({ id: agentSuggestions.id });
	return closed.map((row) => row.id);
}

/**
 * Called once a reply is sent or a new inbound message is delivered: closes the thread's older reply
 * suggestions and tells full-access users.
 */
export async function supersedeOlderReplies(env: CloudflareEnv, messageId: string): Promise<void> {
	const [message] = await getDb(env)
		.select({ mailboxId: messages.mailboxId, threadId: messages.threadId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return;
	await notifySuggestionsQuietly(env, await supersedeThreadReplies(env, message.mailboxId, message.threadId));
}

/**
 * The end of a triage job: a newer message closes older reply suggestions in its thread (this also
 * catches a sent reply the send path missed), then full-access users hear about every change.
 */
export async function settleTriageSuggestions(
	env: CloudflareEnv,
	mailboxId: string,
	source: { id: string; threadId: string | null },
): Promise<void> {
	const superseded = await supersedeThreadReplies(env, mailboxId, source.threadId);
	const own = await getDb(env)
		.select({ id: agentSuggestions.id })
		.from(agentSuggestions)
		.where(eq(agentSuggestions.messageId, source.id));
	await notifySuggestionsQuietly(env, [...own.map((row) => row.id), ...superseded]);
}

/** Expires suggestions still open 14 days after they were made; decided ones are left alone. */
export async function expireOpenSuggestions(env: CloudflareEnv, now = new Date()): Promise<string[]> {
	const cutoff = new Date(now.getTime() - SUGGESTION_EXPIRY_DAYS * DAY_MS);
	const expired = await getDb(env)
		.update(agentSuggestions)
		.set({ status: "expired" })
		.where(and(eq(agentSuggestions.status, "open"), lt(agentSuggestions.createdAt, cutoff)))
		.returning({ id: agentSuggestions.id });
	const ids = expired.map((row) => row.id);
	await notifySuggestionsQuietly(env, ids);
	return ids;
}
