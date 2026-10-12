import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { agentActions } from "@/db/schema/agent-auto-read";
import type { SessionUser } from "@/lib/auth/types";
import { emitCalendarWrites } from "@/lib/calendar/webhook-events";
import { cancelQueuedSend } from "@/lib/email/send";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { AgentActionError } from "./action-error";
import type { AgentActionRow } from "./actions-types";
import { parseActionState, undoRefusal } from "./actions-utils";
import { reopenIfIdle } from "./calendar-state";
import { deserializeEventRow, snapshotValues, type EventSnapshot } from "./invite-actions-utils";

/** What core hands back on undo: the inverse the action stored and the original row's outcome. */
export type CalendarUndoInput = {
	inverse: Record<string, unknown> | null;
	result: Record<string, unknown> | null;
	variant: string;
	suggestionId: string | null;
	mailboxId: string;
	actingUserId: string | null;
};

function stringField(state: Record<string, unknown> | null, key: string): string | null {
	const value = state?.[key];
	return typeof value === "string" ? value : null;
}

async function findLinkedAcceptance(env: CloudflareEnv, row: CalendarUndoInput): Promise<AgentActionRow | null> {
	if (!row.suggestionId) return null;
	const [rsvp] = await getDb(env)
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
	return rsvp ?? null;
}

/**
 * Undoing a new event also takes back its queued "accepted" reply, so the undoing user must pass the
 * same check as undoing that reply directly (send-on-behalf, and the user who sent it). Runs before
 * the undo claims or changes anything; a 409 for a reply that can no longer be taken back is not
 * an authorization failure and is left to the undo itself.
 */
export async function authorizeCreateEventUndo(
	env: CloudflareEnv,
	row: CalendarUndoInput,
	user: Pick<SessionUser, "id" | "role">,
): Promise<void> {
	if (row.variant === "update") return;
	const rsvp = await findLinkedAcceptance(env, row);
	if (!rsvp) return;
	const access = await getMailboxAccessLevel(getDb(env), user, row.mailboxId);
	const refusal = access ? undoRefusal(rsvp, user.id, access, new Date()) : null;
	if (!access || refusal?.status === 403)
		throw new AgentActionError(refusal?.error ?? "You do not have permission to undo this action", 403);
}

/**
 * Takes the linked "accepted" reply back when it is still queued. A reply already sent stays: the
 * event is removed anyway and the card offers "Send decline instead". The caller was authorized by
 * `authorizeCreateEventUndo`; the queued message belongs to the user who sent it.
 */
async function cancelLinkedAcceptance(env: CloudflareEnv, row: CalendarUndoInput, userId: string): Promise<void> {
	const rsvp = await findLinkedAcceptance(env, row);
	const messageId = stringField(parseActionState(rsvp?.after ?? null), "messageId");
	if (!rsvp || !rsvp.actingUserId || !messageId) return;
	if (!(await cancelQueuedSend(env, rsvp.actingUserId, messageId)).ok) return;
	const now = new Date();
	await getDb(env)
		.update(agentActions)
		.set({ status: "undone", undoneAt: now, undoneByUserId: userId, updatedAt: now })
		.where(and(eq(agentActions.id, rsvp.id), eq(agentActions.status, "applied")));
}

/** Undo of `create_event`: removes the event (or puts an updated one back) and, for a new event, cancels a queued reply. */
export async function undoCreateEvent(
	env: CloudflareEnv,
	row: CalendarUndoInput,
	userId: string,
	ctx: CapabilityCallContext,
): Promise<void> {
	const db = getDb(env);
	const eventId = stringField(row.inverse, "eventId") ?? stringField(row.result, "eventId");
	if (row.variant === "update") {
		const before = row.inverse as EventSnapshot | null;
		if (!eventId || !before) throw new AgentActionError("The event could not be restored", 409);
		const restored = await db
			.update(calendarEvents)
			.set({ ...snapshotValues(before), updatedAt: new Date() })
			.where(eq(calendarEvents.id, eventId))
			.returning();
		if (restored.length === 0) throw new AgentActionError("The event is no longer on your calendar", 409);
		await emitCalendarWrites(ctx, [["updated", restored[0]]]);
	} else {
		if (eventId) {
			const [removed] = await db.delete(calendarEvents).where(eq(calendarEvents.id, eventId)).returning();
			if (removed) await emitCalendarWrites(ctx, [["deleted", removed]]);
		}
		await cancelLinkedAcceptance(env, row, userId);
	}
	await reopenIfIdle(env, row.suggestionId);
}

/** Undo of `delete_event`: recreates the event from the row stored before it was removed. */
export async function undoDeleteEvent(
	env: CloudflareEnv,
	row: CalendarUndoInput,
	ctx: CapabilityCallContext,
): Promise<void> {
	const event = deserializeEventRow(row.inverse);
	if (!event) throw new AgentActionError("The event could not be restored", 409);
	const [restored] = await getDb(env).insert(calendarEvents).values(event).onConflictDoNothing().returning();
	if (restored) await emitCalendarWrites(ctx, [["created", restored]]);
	await reopenIfIdle(env, row.suggestionId);
}

/** Undo of `send_rsvp`: only a reply still waiting in the outbound queue can be taken back. */
export async function undoRsvp(env: CloudflareEnv, row: CalendarUndoInput): Promise<void> {
	const messageId = stringField(row.inverse, "messageId") ?? stringField(row.result, "messageId");
	const cancelled = row.actingUserId && messageId ? await cancelQueuedSend(env, row.actingUserId, messageId) : null;
	if (!cancelled?.ok) throw new AgentActionError("The reply was already sent, so Kite left it", 409);
	await reopenIfIdle(env, row.suggestionId);
}
