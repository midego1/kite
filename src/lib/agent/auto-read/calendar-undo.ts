import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { agentActions } from "@/db/schema/agent-auto-read";
import { cancelQueuedSend } from "@/lib/email/send";
import { AgentActionError } from "./action-error";
import type { AgentActionRow } from "./actions-types";
import { parseActionState } from "./actions-utils";
import { reopenIfIdle } from "./calendar-state";
import { deserializeEventRow, snapshotValues, type EventSnapshot } from "./invite-actions-utils";

function stringField(state: Record<string, unknown> | null, key: string): string | null {
	const value = state?.[key];
	return typeof value === "string" ? value : null;
}

/**
 * Takes the linked "accepted" reply back when it is still queued. A reply already sent stays: the
 * event is removed anyway and the card offers "Send decline instead".
 */
async function cancelLinkedAcceptance(env: CloudflareEnv, row: AgentActionRow, userId: string): Promise<void> {
	if (!row.suggestionId) return;
	const db = getDb(env);
	const [rsvp] = await db
		.select()
		.from(agentActions)
		.where(
			and(
				eq(agentActions.suggestionId, row.suggestionId),
				eq(agentActions.action, "send_rsvp"),
				eq(agentActions.variant, "accepted"),
				eq(agentActions.status, "applied"),
			),
		)
		.limit(1);
	const messageId = stringField(parseActionState(rsvp?.after ?? null), "messageId");
	if (!rsvp || !rsvp.actingUserId || !messageId) return;
	if (!(await cancelQueuedSend(env, rsvp.actingUserId, messageId)).ok) return;
	const now = new Date();
	await db
		.update(agentActions)
		.set({ status: "undone", undoneAt: now, undoneByUserId: userId, updatedAt: now })
		.where(and(eq(agentActions.id, rsvp.id), eq(agentActions.status, "applied")));
}

/** Undo of `create_event`: removes the event (or puts an updated one back) and, for a new event, cancels a queued reply. */
export async function undoCreateEvent(env: CloudflareEnv, row: AgentActionRow, userId: string): Promise<void> {
	const db = getDb(env);
	const eventId = stringField(parseActionState(row.after), "eventId");
	if (row.variant === "update") {
		const before = parseActionState(row.before) as EventSnapshot | null;
		if (!eventId || !before) throw new AgentActionError("The event could not be restored", 409);
		const restored = await db
			.update(calendarEvents)
			.set({ ...snapshotValues(before), updatedAt: new Date() })
			.where(eq(calendarEvents.id, eventId))
			.returning({ id: calendarEvents.id });
		if (restored.length === 0) throw new AgentActionError("The event is no longer on your calendar", 409);
	} else {
		if (eventId) await db.delete(calendarEvents).where(eq(calendarEvents.id, eventId));
		await cancelLinkedAcceptance(env, row, userId);
	}
	await reopenIfIdle(env, row.suggestionId);
}

/** Undo of `delete_event`: recreates the event from the row stored before it was removed. */
export async function undoDeleteEvent(env: CloudflareEnv, row: AgentActionRow): Promise<void> {
	const event = deserializeEventRow(parseActionState(row.before));
	if (!event) throw new AgentActionError("The event could not be restored", 409);
	await getDb(env).insert(calendarEvents).values(event).onConflictDoNothing();
	await reopenIfIdle(env, row.suggestionId);
}

/** Undo of `send_rsvp`: only a reply still waiting in the outbound queue can be taken back. */
export async function undoRsvp(env: CloudflareEnv, row: AgentActionRow): Promise<void> {
	const messageId = stringField(parseActionState(row.after), "messageId");
	const cancelled = row.actingUserId && messageId ? await cancelQueuedSend(env, row.actingUserId, messageId) : null;
	if (!cancelled?.ok) throw new AgentActionError("The reply was already sent, so Kite left it", 409);
	await reopenIfIdle(env, row.suggestionId);
}
