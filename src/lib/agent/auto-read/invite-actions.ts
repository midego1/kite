import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import type { SessionUser } from "@/lib/auth/types";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { AgentActionError } from "./action-error";
import { draftReplyEffect } from "./action-effects";
import { settled } from "./action-response";
import type { ActionEffect, ExecuteActionResult } from "./actions-types";
import { parseActionState } from "./actions-utils";
import {
	createEventEffect,
	deleteEventEffect,
	findInviteEvent,
	rsvpEffect,
	updateEventEffect,
} from "./calendar-effects";
import { retireLiveRows, rsvpState } from "./calendar-state";
import { executeAction } from "./execute";
import { inviteOptionRefusal, proposalBody, type InviteOption, type Partstat } from "./invite-actions-utils";
import { proposeSlotsForInvite } from "./invite";
import { localizeAllDay } from "./invite-utils";
import { generateProposalIntro } from "./invite-proposal";
import type { AgentActionType } from "./policy-types";
import { notifySuggestionsQuietly } from "./suggestion-events";
import type { CalendarInvitePayload, SuggestionStatus } from "./suggestion-types";
import { parseSuggestionPayload } from "./suggestion-utils";

type InviteRow = { id: string; mailboxId: string; messageId: string; status: SuggestionStatus };

type Context = {
	env: CloudflareEnv;
	user: SessionUser;
	access: MailboxAccessLevel;
	row: InviteRow;
	payload: CalendarInvitePayload;
	reviewerUserId: string;
	source: { id: string; providerMessageId: string | null };
};

type InviteResult = { status: string; option: InviteOption; actionId: string; [key: string]: unknown };

async function loadContext(
	env: CloudflareEnv,
	user: SessionUser,
	access: MailboxAccessLevel,
	row: InviteRow,
	deviceTimeZone: string | null,
): Promise<Context> {
	const db = getDb(env);
	const [suggestion] = await db
		.select({ payload: agentSuggestions.payload, reviewerUserId: agentSuggestions.reviewerUserId })
		.from(agentSuggestions)
		.where(eq(agentSuggestions.id, row.id))
		.limit(1);
	const payload = suggestion && parseSuggestionPayload("calendar_invite", parseActionState(suggestion.payload));
	if (!suggestion || !payload) throw new AgentActionError("This invitation can no longer be answered", 409);
	const [source] = await db
		.select({ id: messages.id, providerMessageId: messages.providerMessageId })
		.from(messages)
		.where(eq(messages.id, row.messageId))
		.limit(1);
	if (!source) throw new AgentActionError("The invitation message no longer exists", 409);
	return {
		env,
		user,
		access,
		row,
		payload: anchorAllDay(payload, user, suggestion.reviewerUserId, deviceTimeZone),
		reviewerUserId: suggestion.reviewerUserId,
		source,
	};
}

/**
 * Triage anchors an all-day invite at midnight UTC when the reviewer has no saved zone, but the
 * calendar then renders in the device zone, so the accepting device's zone decides the date.
 */
function anchorAllDay(
	payload: CalendarInvitePayload,
	user: SessionUser,
	reviewerUserId: string,
	deviceTimeZone: string | null,
): CalendarInvitePayload {
	if (!payload.allDay || user.timeZone || user.id !== reviewerUserId || !deviceTimeZone) return payload;
	return localizeAllDay(payload, deviceTimeZone);
}

function run(ctx: Context, action: AgentActionType, variant: string, effect: ActionEffect) {
	return executeAction({
		env: ctx.env,
		mailboxId: ctx.row.mailboxId,
		suggestionId: ctx.row.id,
		messageId: ctx.row.messageId,
		action,
		variant,
		initiator: "user",
		actingUserId: ctx.user.id,
		permissions: ctx.access,
		effect,
	});
}

function sendRsvp(ctx: Context, partstat: Partstat): Promise<ExecuteActionResult> {
	return run(
		ctx,
		"send_rsvp",
		partstat,
		rsvpEffect({
			env: ctx.env,
			actor: ctx.user,
			suggestionId: ctx.row.id,
			mailboxId: ctx.row.mailboxId,
			payload: ctx.payload,
			partstat,
			source: ctx.source,
		}),
	);
}

function createEvent(ctx: Context): Promise<ExecuteActionResult> {
	return run(
		ctx,
		"create_event",
		"",
		createEventEffect({
			env: ctx.env,
			reviewerUserId: ctx.reviewerUserId,
			messageId: ctx.row.messageId,
			payload: ctx.payload,
		}),
	);
}

async function closeSuggestion(ctx: Context): Promise<void> {
	await getDb(ctx.env)
		.update(agentSuggestions)
		.set({ status: "accepted", decidedAt: new Date(), decidedByUserId: ctx.user.id })
		.where(and(eq(agentSuggestions.id, ctx.row.id), eq(agentSuggestions.status, "open")));
}

async function accept(ctx: Context, option: InviteOption): Promise<InviteResult> {
	const created = settled(await createEvent(ctx));
	const rsvp = settled(await sendRsvp(ctx, "accepted"));
	await closeSuggestion(ctx);
	return {
		status: "accepted",
		option,
		actionId: created.actionId,
		rsvpActionId: rsvp.actionId,
		eventId: created.after?.eventId ?? null,
	};
}

async function decline(ctx: Context, option: InviteOption): Promise<InviteResult> {
	const rsvp = settled(await sendRsvp(ctx, "declined"));
	await closeSuggestion(ctx);
	return { status: "accepted", option, actionId: rsvp.actionId };
}

/** The reply goes first: its live-row guard makes a second click a 409 or a no-op before any event changes. */
async function declineInstead(ctx: Context, option: InviteOption): Promise<InviteResult> {
	const rsvp = settled(await sendRsvp(ctx, "declined"));
	if (rsvp.status === "skipped") return { status: "accepted", option, actionId: rsvp.actionId, noop: true };
	await retireLiveRows(ctx.env, {
		suggestionId: ctx.row.id,
		rows: [{ action: "create_event" }],
		userId: ctx.user.id,
	});
	const stored = await findInviteEvent(ctx.env, ctx.reviewerUserId, { uid: ctx.payload.uid });
	const removed = stored ? settled(await run(ctx, "delete_event", "", deleteEventEffect(ctx.env, stored))) : null;
	return { status: "accepted", option, actionId: rsvp.actionId, deleteActionId: removed?.actionId ?? null };
}

async function acceptInstead(ctx: Context, option: InviteOption): Promise<InviteResult> {
	const rsvp = settled(await sendRsvp(ctx, "accepted"));
	if (rsvp.status === "skipped") return { status: "accepted", option, actionId: rsvp.actionId, noop: true };
	await retireLiveRows(ctx.env, {
		suggestionId: ctx.row.id,
		rows: [{ action: "delete_event" }, { action: "create_event" }],
		userId: ctx.user.id,
	});
	const created = settled(await createEvent(ctx));
	return {
		status: "accepted",
		option,
		actionId: rsvp.actionId,
		createActionId: created.actionId,
		eventId: created.after?.eventId ?? null,
	};
}

async function update(ctx: Context, option: InviteOption): Promise<InviteResult> {
	const effect = await updateEventEffect({ env: ctx.env, reviewerUserId: ctx.reviewerUserId, payload: ctx.payload });
	const result = settled(await run(ctx, "create_event", "update", effect));
	await closeSuggestion(ctx);
	return { status: "accepted", option, actionId: result.actionId, eventId: result.after?.eventId ?? null };
}

async function remove(ctx: Context, option: InviteOption): Promise<InviteResult> {
	const stored = await findInviteEvent(ctx.env, ctx.reviewerUserId, {
		id: ctx.payload.existingEventId,
		uid: ctx.payload.uid,
	});
	if (!stored) throw new AgentActionError("The event is no longer on your calendar", 409);
	const result = settled(await run(ctx, "delete_event", "", deleteEventEffect(ctx.env, stored)));
	await closeSuggestion(ctx);
	return { status: "accepted", option, actionId: result.actionId, eventId: stored.id };
}

/**
 * Saves a reply draft to the organizer with the computed free slots appended by code. Nothing is sent
 * and the suggestion stays open, so the user can still accept or decline.
 */
async function propose(ctx: Context, option: InviteOption): Promise<InviteResult> {
	const slots = ctx.payload.proposals.length
		? ctx.payload.proposals
		: await proposeSlotsForInvite(ctx.env, ctx.reviewerUserId, ctx.payload);
	if (slots.length === 0) throw new AgentActionError("No free time was found in the next seven days", 409);
	const intro = await generateProposalIntro(ctx.env, {
		suggestionId: ctx.row.id,
		mailboxId: ctx.row.mailboxId,
		messageId: ctx.row.messageId,
	});
	const body = proposalBody(intro ?? "", slots, normalizeTimeZone(ctx.user.timeZone));
	const result = settled(
		await run(
			ctx,
			"create_draft",
			"",
			draftReplyEffect({
				env: ctx.env,
				reviewer: ctx.user,
				mailboxId: ctx.row.mailboxId,
				sourceMessageId: ctx.row.messageId,
				body,
				to: ctx.payload.organizer ?? undefined,
			}),
		),
	);
	const draftId = result.after?.draftId;
	if (typeof draftId !== "string") throw new AgentActionError("The draft could not be saved", 409);
	await getDb(ctx.env).update(agentSuggestions).set({ draftId }).where(eq(agentSuggestions.id, ctx.row.id));
	return { status: ctx.row.status, option, actionId: result.actionId, draftId, url: `/drafts/${draftId}` };
}

const HANDLERS: Record<InviteOption, (ctx: Context, option: InviteOption) => Promise<InviteResult>> = {
	accept,
	decline,
	propose,
	update,
	remove,
	decline_instead: declineInstead,
	accept_instead: acceptInstead,
};

/**
 * Runs one answer to a calendar invitation for a user who has full access on the mailbox. Each step
 * goes through the executor, so it is audited, undoable and runs once even on a double click.
 */
export async function acceptInvite(
	env: CloudflareEnv,
	user: SessionUser,
	access: MailboxAccessLevel,
	row: InviteRow,
	option: string,
	deviceTimeZone: string | null = null,
): Promise<InviteResult> {
	const ctx = await loadContext(env, user, access, row, deviceTimeZone);
	const refusal = inviteOptionRefusal({
		option,
		status: row.status,
		payload: ctx.payload,
		rsvp: await rsvpState(env, row.id),
		canSend: access.canSendOnBehalf,
	});
	if (refusal) throw new AgentActionError(refusal.error, refusal.status);
	const result = await HANDLERS[option as InviteOption](ctx, option as InviteOption);
	await notifySuggestionsQuietly(env, [row.id]);
	return result;
}
