import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb } from "@/db";
import { mailboxAgentSettings, messages } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel, listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { AgentActionError } from "./action-error";
import { settled } from "./action-response";
import { discardAgentDraft, dismissSuggestionEffect } from "./action-effects";
import type { ActionEffect } from "./actions-types";
import { executeAction } from "./execute";
import { acceptInvite } from "./invite-actions";
import { senderAddressOf } from "./facts-utils";
import { muteSender } from "./muted-senders";
import {
	acceptRefusal,
	countByKind,
	dismissRefusal,
	reviewRefusal,
	sumTotals,
	toApiSuggestion,
	type SuggestionStatusFilter,
} from "./suggestion-api-utils";
import { markSpamEffect } from "./suggestion-effects";
import { notifySuggestionsQuietly } from "./suggestion-events";

const LIST_LIMIT = 200;
const drafts = alias(messages, "draft");

export type SuggestionListQuery = {
	mailboxId: string | null;
	status: SuggestionStatusFilter;
	messageId?: string | null;
	threadId?: string | null;
};

/** The mailboxes the list covers: the one asked for, or every mailbox where the user has full access. */
async function listedMailboxes(env: CloudflareEnv, user: SessionUser, mailboxId: string | null) {
	const db = getDb(env);
	if (mailboxId && !(await getMailboxAccessLevel(db, user, mailboxId))?.canManage) return null;
	return (await listAccessibleMailboxes(db, user))
		.filter((row) => row.permission === "full_access" && (!mailboxId || row.id === mailboxId))
		.map((row) => ({ id: row.id, address: `${row.localPart}@${row.hostname}` }));
}

/** Every matching suggestion per kind, in one COUNT, for lists cut off at the limit. */
async function countMatches(env: CloudflareEnv, conditions: SQL[]): Promise<Record<string, number>> {
	const rows = await getDb(env)
		.select({ kind: agentSuggestions.kind, total: count() })
		.from(agentSuggestions)
		.where(and(...conditions))
		.groupBy(agentSuggestions.kind);
	return Object.fromEntries(rows.map((row) => [row.kind, row.total]));
}

/**
 * Suggestions for users with full access, newest first, plus each listed mailbox's autonomy so the
 * navigation can hide For you when every mailbox is off. The list stops at 200 rows; `total` counts
 * every match and `kindTotals` per kind. Null when the requested mailbox is not one the user has full access to.
 */
export async function listSuggestions(env: CloudflareEnv, user: SessionUser, query: SuggestionListQuery) {
	const mailboxes = await listedMailboxes(env, user, query.mailboxId);
	if (!mailboxes) return null;
	const ids = mailboxes.map((mailbox) => mailbox.id);
	if (ids.length === 0) return { suggestions: [], total: 0, kindTotals: {}, mailboxes: [] };
	const db = getDb(env);
	const settings = await db
		.select({ mailboxId: mailboxAgentSettings.mailboxId, autonomy: mailboxAgentSettings.autonomy })
		.from(mailboxAgentSettings)
		.where(inArray(mailboxAgentSettings.mailboxId, ids));
	const autonomy = new Map(settings.map((row) => [row.mailboxId, row.autonomy]));
	const conditions: SQL[] = [inArray(agentSuggestions.mailboxId, ids)];
	if (query.status !== "all") conditions.push(eq(agentSuggestions.status, query.status));
	if (query.messageId) conditions.push(eq(agentSuggestions.messageId, query.messageId));
	if (query.threadId) conditions.push(eq(agentSuggestions.threadId, query.threadId));
	const rows = await db
		.select({
			id: agentSuggestions.id,
			mailboxId: agentSuggestions.mailboxId,
			messageId: agentSuggestions.messageId,
			threadId: agentSuggestions.threadId,
			kind: agentSuggestions.kind,
			status: agentSuggestions.status,
			title: agentSuggestions.title,
			payload: agentSuggestions.payload,
			draftId: agentSuggestions.draftId,
			model: agentSuggestions.model,
			createdAt: agentSuggestions.createdAt,
			decidedAt: agentSuggestions.decidedAt,
			expiresAt: agentSuggestions.expiresAt,
			subject: messages.subject,
			from: messages.fromAddr,
			draftUserId: drafts.userId,
			draftStatus: drafts.status,
		})
		.from(agentSuggestions)
		.leftJoin(messages, eq(messages.id, agentSuggestions.messageId))
		.leftJoin(drafts, eq(drafts.id, agentSuggestions.draftId))
		.where(and(...conditions))
		// Whole-second timestamps: insertion order breaks ties between suggestions from one triage job.
		.orderBy(desc(agentSuggestions.createdAt), desc(sql`"agent_suggestions"."rowid"`))
		.limit(LIST_LIMIT);
	const kindTotals = rows.length < LIST_LIMIT ? countByKind(rows) : await countMatches(env, conditions);
	return {
		suggestions: rows.map((row) => toApiSuggestion(row, user.id)),
		total: sumTotals(kindTotals),
		kindTotals,
		mailboxes: mailboxes.map((mailbox) => ({ ...mailbox, autonomy: autonomy.get(mailbox.id) ?? "off" })),
	};
}

/** The suggestion and the caller's access; anyone without full access cannot tell it exists. */
async function loadForDecision(env: CloudflareEnv, user: SessionUser, suggestionId: string) {
	const db = getDb(env);
	const [row] = await db
		.select({
			id: agentSuggestions.id,
			mailboxId: agentSuggestions.mailboxId,
			messageId: agentSuggestions.messageId,
			kind: agentSuggestions.kind,
			status: agentSuggestions.status,
			draftId: agentSuggestions.draftId,
			from: messages.fromAddr,
		})
		.from(agentSuggestions)
		.leftJoin(messages, eq(messages.id, agentSuggestions.messageId))
		.where(eq(agentSuggestions.id, suggestionId))
		.limit(1);
	const access = row ? await getMailboxAccessLevel(db, user, row.mailboxId) : null;
	if (!row || !access?.canManage) throw new AgentActionError("Suggestion not found", 404);
	return { row, access };
}

async function reviewDraft(env: CloudflareEnv, user: SessionUser, status: string, draftId: string) {
	const [draft] = await getDb(env)
		.select({ draftUserId: messages.userId, draftStatus: messages.status })
		.from(messages)
		.where(eq(messages.id, draftId))
		.limit(1);
	const refusal = reviewRefusal(draft, user.id);
	if (refusal) throw new AgentActionError(refusal.error, refusal.status);
	return { status, draftId, url: `/drafts/${draftId}` };
}

/**
 * Accepts a suggestion with one of its options. `review` on a reply only hands back the draft to open,
 * and only to the reviewer who owns it; the user sends it from the composer. `mark_spam` on a phishing
 * warning moves the message to Spam through the executor, so it is audited and can be undone.
 */
export async function acceptSuggestion(env: CloudflareEnv, user: SessionUser, suggestionId: string, option: string) {
	const { row, access } = await loadForDecision(env, user, suggestionId);
	if (row.kind === "calendar_invite") return acceptInvite(env, user, access, row, option);
	const refusal = acceptRefusal(row, option);
	if (refusal) throw new AgentActionError(refusal.error, refusal.status);
	if (row.kind === "reply") return reviewDraft(env, user, row.status, row.draftId!);
	const result = settled(
		await executeAction({
			env,
			mailboxId: row.mailboxId,
			suggestionId: row.id,
			messageId: row.messageId,
			action: "move",
			variant: "spam",
			initiator: "user",
			actingUserId: user.id,
			permissions: access,
			effect: await markSpamEffect(env, user, row),
		}),
	);
	await notifySuggestionsQuietly(env, [row.id]);
	return { status: "accepted", actionId: result.actionId };
}

/**
 * Also deletes the reply's agent draft and unlinks it, so a reopened suggestion offers no stale draft.
 * A draft a person already edited or sent is kept and reported as `keptDraftId`.
 */
function withDraftDiscard(
	env: CloudflareEnv,
	effect: ActionEffect,
	suggestionId: string,
	draftId: string,
): ActionEffect {
	return {
		...effect,
		async apply(ids) {
			const after = await effect.apply(ids);
			try {
				await discardAgentDraft(env, draftId);
			} catch (error) {
				if (error instanceof AgentActionError && error.status === 409) return { ...after, keptDraftId: draftId };
				throw error;
			}
			await getDb(env).update(agentSuggestions).set({ draftId: null }).where(eq(agentSuggestions.id, suggestionId));
			return { ...after, discardedDraftId: draftId };
		},
	};
}

function withMute(env: CloudflareEnv, effect: ActionEffect, mailboxId: string, sender: string): ActionEffect {
	return {
		...effect,
		async apply(ids) {
			const after = await effect.apply(ids);
			return (await muteSender(env, mailboxId, sender)) ? { ...after, mutedSender: sender } : after;
		},
	};
}

/**
 * Dismisses a suggestion as an undoable `dismiss` action. With `muteSender`, the sender is also added
 * to the mailbox's muted senders, which the planner skips from then on; undo unmutes it again.
 */
export async function dismissSuggestion(
	env: CloudflareEnv,
	user: SessionUser,
	suggestionId: string,
	options: { muteSender?: boolean; discardDraft?: boolean } | null,
) {
	const { row, access } = await loadForDecision(env, user, suggestionId);
	if (!options) throw new AgentActionError("Invalid request", 400);
	const refusal = dismissRefusal(row.status);
	if (refusal) throw new AgentActionError(refusal.error, refusal.status);
	const sender = options.muteSender && row.from ? senderAddressOf(row.from) : null;
	let base = await dismissSuggestionEffect(env, row.id, user.id);
	if (options.discardDraft && row.kind === "reply" && row.draftId)
		base = withDraftDiscard(env, base, row.id, row.draftId);
	const result = settled(
		await executeAction({
			env,
			mailboxId: row.mailboxId,
			suggestionId: row.id,
			messageId: row.messageId,
			action: "dismiss",
			initiator: "user",
			actingUserId: user.id,
			permissions: access,
			effect: sender ? withMute(env, base, row.mailboxId, sender) : base,
		}),
	);
	await notifySuggestionsQuietly(env, [row.id]);
	return { status: "dismissed", actionId: result.actionId, mutedSender: sender };
}
