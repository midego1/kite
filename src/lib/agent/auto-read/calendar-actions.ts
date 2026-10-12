import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import type { CapabilityCallContext, JsonValue } from "@/lib/modules/module-types";
import { AgentActionError } from "./action-error";
import type { ActionEffect, ActionState } from "./actions-types";
import {
	createEventEffect,
	deleteEventEffect,
	findInviteEvent,
	rsvpEffect,
	updateEventEffect,
} from "./calendar-effects";
import { authorizeCreateEventUndo, undoCreateEvent, undoDeleteEvent, undoRsvp } from "./calendar-undo";
import type { CalendarUndoInput } from "./calendar-undo";
import { calendarInviteSchema } from "./suggestion-utils";

export type CalendarActionName = "createEvent" | "deleteEvent" | "sendRsvp";

const createInput = z.object({
	variant: z.enum(["", "update"]),
	payload: calendarInviteSchema,
	reviewerUserId: z.string().min(1),
	messageId: z.string().min(1),
});
const deleteInput = z.object({
	eventId: z.string().min(1),
	uid: z.string().min(1),
	reviewerUserId: z.string().min(1),
});
const rsvpInput = z.object({
	partstat: z.enum(["accepted", "declined"]),
	payload: calendarInviteSchema,
	sourceMessageId: z.string().min(1),
	suggestionId: z.string().min(1),
	mailboxId: z.string().min(1),
});

export type CalendarActionCall =
	| { op: "execute"; actionId: string; input?: JsonValue }
	| { op: "undo" | "authorize_undo"; actionId: string; inverse: JsonValue };

/** Ids derived from the action id, so running the same action twice finds what the first run made. */
function derivedId(prefix: string, actionId: string): string {
	return `${prefix}_${actionId.replace(/^aact_/, "")}`;
}

/** Runs the effect unless it already happened; a resumed action therefore never applies twice. */
async function applyOnce(effect: ActionEffect): Promise<ActionState> {
	const ids = effect.ids ?? {};
	const done = effect.check ? await effect.check(ids) : null;
	return { ...ids, ...(done ?? (await effect.apply(ids))) };
}

async function actingUser(env: CloudflareEnv, ctx: CapabilityCallContext): Promise<SessionUser> {
	if (!ctx.viewer) throw new AgentActionError("This action needs a signed-in user", 403);
	const [user] = await getDb(env).select().from(users).where(eq(users.id, ctx.viewer.userId)).limit(1);
	if (!user) throw new AgentActionError("User not found", 404);
	return user as SessionUser;
}

async function execute(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	name: CalendarActionName,
	actionId: string,
	raw: JsonValue | undefined,
): Promise<{ result: ActionState; inverse: JsonValue | null }> {
	if (name === "createEvent") {
		const input = createInput.parse(raw);
		if (input.variant === "update") {
			const effect = await updateEventEffect({
				env,
				ctx,
				reviewerUserId: input.reviewerUserId,
				payload: input.payload,
			});
			return { result: await applyOnce(effect), inverse: null };
		}
		const effect = createEventEffect({
			env,
			ctx,
			reviewerUserId: input.reviewerUserId,
			messageId: input.messageId,
			payload: input.payload,
			eventId: derivedId("evt", actionId),
		});
		const result = await applyOnce(effect);
		return { result, inverse: { eventId: String(result.eventId) } };
	}
	if (name === "deleteEvent") {
		const input = deleteInput.parse(raw);
		const stored = await findInviteEvent(env, input.reviewerUserId, { id: input.eventId, uid: input.uid });
		if (!stored) return { result: { eventId: input.eventId }, inverse: null };
		return { result: await applyOnce(deleteEventEffect(env, stored, ctx)), inverse: null };
	}
	const input = rsvpInput.parse(raw);
	const actor = await actingUser(env, ctx);
	const effect = rsvpEffect({
		env,
		ctx,
		actor,
		suggestionId: input.suggestionId,
		mailboxId: input.mailboxId,
		payload: input.payload,
		partstat: input.partstat,
		source: { id: input.sourceMessageId },
		messageId: derivedId("msg", actionId),
	});
	const result = await applyOnce(effect);
	return { result, inverse: { messageId: String(result.messageId) } };
}

const undoInput = z.object({
	inverse: z.record(z.string(), z.unknown()).nullable(),
	result: z.record(z.string(), z.unknown()).nullable(),
	variant: z.string(),
	suggestionId: z.string().nullable(),
	mailboxId: z.string(),
	actingUserId: z.string().nullable(),
});

async function undo(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	name: CalendarActionName,
	raw: JsonValue,
	authorizeOnly: boolean,
): Promise<void> {
	if (!ctx.viewer) throw new AgentActionError("This action needs a signed-in user", 403);
	const row: CalendarUndoInput = undoInput.parse(raw);
	const user = { id: ctx.viewer.userId, role: ctx.viewer.role as SessionUser["role"] };
	if (name === "createEvent") {
		await authorizeCreateEventUndo(env, row, user);
		if (!authorizeOnly) await undoCreateEvent(env, row, user.id, ctx);
	} else if (authorizeOnly) return;
	else if (name === "deleteEvent") await undoDeleteEvent(env, row, ctx);
	else await undoRsvp(env, row);
}

function refusal(error: unknown): { status: 403 | 409; error: string } {
	if (error instanceof AgentActionError) return { status: error.status === 403 ? 403 : 409, error: error.message };
	return { status: 409, error: error instanceof Error ? error.message.slice(0, 200) : "The action failed" };
}

/** The handler behind a calendar `action` capability: `op` selects execute or undo, both idempotent by `actionId`. */
export async function runCalendarAction(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	name: CalendarActionName,
	call: CalendarActionCall,
): Promise<JsonValue> {
	try {
		if (call.op !== "execute") {
			await undo(env, ctx, name, call.inverse, call.op === "authorize_undo");
			return { result: {}, inverse: null };
		}
		const { result, inverse } = await execute(env, ctx, name, call.actionId, call.input);
		return { result: result as JsonValue, inverse };
	} catch (error) {
		return { result: {}, inverse: null, refused: refusal(error) };
	}
}
