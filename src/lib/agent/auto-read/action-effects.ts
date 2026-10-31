import { and, eq, isNotNull, notExists } from "drizzle-orm";
import { getDb } from "@/db";
import { agentDraftMetadata, messages } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import type { SessionUser } from "@/lib/auth/types";
import { newId } from "@/lib/ids";
import { runEmailTool } from "../tools";
import { AgentActionError } from "./action-error";
import type { ActionEffect, AgentActionRow } from "./actions-types";
import { parseActionState } from "./actions-utils";
import { unmuteSender, untrustSender } from "./muted-senders";
import type { AgentActionType } from "./policy-types";
import type { UndoCounts } from "../chat-actions-types";
import { notifySuggestionsQuietly } from "./suggestion-events";
import { messageAttachmentKeys } from "@/lib/email/attachments";
import { deleteUnreferencedObjects } from "@/lib/email/attachment-storage";
import { htmlBodyObjectKey } from "@/lib/email/bodies-utils";
import { undoCreateFolder, undoMarkRead, undoMove, undoSetFolder } from "./organize-undo";

type SuggestionStatus = (typeof agentSuggestions.$inferSelect)["status"];

async function suggestionStatus(env: CloudflareEnv, suggestionId: string): Promise<SuggestionStatus | null> {
	const [row] = await getDb(env)
		.select({ status: agentSuggestions.status })
		.from(agentSuggestions)
		.where(eq(agentSuggestions.id, suggestionId))
		.limit(1);
	return row?.status ?? null;
}

/** Dismisses a suggestion; `before` keeps its previous status so undo can reopen it. */
export async function dismissSuggestionEffect(
	env: CloudflareEnv,
	suggestionId: string,
	userId: string,
): Promise<ActionEffect> {
	const previous = await suggestionStatus(env, suggestionId);
	if (!previous) throw new AgentActionError("Suggestion not found", 404);
	return {
		before: { status: previous },
		async apply() {
			await getDb(env)
				.update(agentSuggestions)
				.set({ status: "dismissed", decidedAt: new Date(), decidedByUserId: userId })
				.where(eq(agentSuggestions.id, suggestionId));
			return { status: "dismissed" };
		},
		async check() {
			return (await suggestionStatus(env, suggestionId)) === "dismissed" ? { status: "dismissed" } : null;
		},
	};
}

async function draftExists(env: CloudflareEnv, draftId: string): Promise<boolean> {
	const [row] = await getDb(env).select({ id: messages.id }).from(messages).where(eq(messages.id, draftId)).limit(1);
	return !!row;
}

/** Saves a reply draft under an id chosen up front, so a resumed action finds the draft it already made. */
export function draftReplyEffect(input: {
	env: CloudflareEnv;
	reviewer: SessionUser;
	mailboxId: string;
	sourceMessageId: string;
	body: string;
	/** Address the draft goes to instead of the source's From or Reply-To. */
	to?: string;
}): ActionEffect {
	return {
		ids: { draftId: newId("msg") },
		async apply(ids) {
			const result = (await runEmailTool(
				{
					env: input.env,
					user: input.reviewer,
					mailboxId: input.mailboxId,
					origin: "auto",
					draftId: ids.draftId,
					replyTo: input.to,
				},
				"draft_reply",
				{ emailId: input.sourceMessageId, body: input.body },
			)) as { draftId: string };
			return { draftId: result.draftId };
		},
		async check(ids) {
			return ids.draftId && (await draftExists(input.env, ids.draftId)) ? { draftId: ids.draftId } : null;
		},
	};
}

async function reopenSuggestion(env: CloudflareEnv, row: AgentActionRow): Promise<void> {
	if (!row.suggestionId) return;
	const before = parseActionState(row.before);
	const status = before?.status === "open" || before?.status === "accepted" ? before.status : "open";
	await getDb(env)
		.update(agentSuggestions)
		.set({ status, decidedAt: null, decidedByUserId: null })
		.where(and(eq(agentSuggestions.id, row.suggestionId), eq(agentSuggestions.status, "dismissed")));
	// Only a sender this dismiss muted or trusted is recorded in `after`, so an older entry survives the undo.
	const after = parseActionState(row.after);
	if (typeof after?.mutedSender === "string") await unmuteSender(env, row.mailboxId, after.mutedSender);
	if (typeof after?.trustedSender === "string") await untrustSender(env, row.mailboxId, after.trustedSender);
	await notifySuggestionsQuietly(env, [row.suggestionId]);
}

async function discardDraft(env: CloudflareEnv, row: AgentActionRow): Promise<void> {
	const draftId = parseActionState(row.after)?.draftId;
	if (typeof draftId === "string") await discardAgentDraft(env, draftId);
}

/**
 * Deletes an agent draft with its attachments. A draft a person edited, queued or sent is left alone
 * and a 409 thrown; a draft that no longer exists is a no-op.
 */
export async function discardAgentDraft(env: CloudflareEnv, draftId: string): Promise<void> {
	const db = getDb(env);
	const [draft] = await db
		.select({ status: messages.status, humanEditedAt: agentDraftMetadata.humanEditedAt })
		.from(messages)
		.leftJoin(agentDraftMetadata, eq(agentDraftMetadata.draftId, messages.id))
		.where(eq(messages.id, draftId))
		.limit(1);
	if (!draft) return;
	if (draft.status !== "draft") throw new AgentActionError("The draft was already sent, so Kite kept it", 409);
	if (draft.humanEditedAt) throw new AgentActionError("The draft was edited, so Kite kept it", 409);
	const attachmentKeys = await messageAttachmentKeys(env, [draftId]);
	// The delete re-checks both conditions, so a send or edit that lands after the read above wins.
	const deleted = await db
		.delete(messages)
		.where(
			and(
				eq(messages.id, draftId),
				eq(messages.status, "draft"),
				notExists(
					db
						.select({ id: agentDraftMetadata.draftId })
						.from(agentDraftMetadata)
						.where(and(eq(agentDraftMetadata.draftId, draftId), isNotNull(agentDraftMetadata.humanEditedAt))),
				),
			),
		)
		.returning({ rawR2Key: messages.rawR2Key });
	if (deleted.length === 0) throw new AgentActionError("The draft changed, so Kite kept it", 409);
	// The rows went first; an object another message still names (a sent copy) stays.
	await deleteUnreferencedObjects(env, {
		attachmentKeys,
		rawKeys: [deleted[0]?.rawR2Key ?? null],
		ownedKeys: [htmlBodyObjectKey(draftId)],
	});
}

/**
 * The inverse of each undoable core action; the registry in actions-utils.ts says who may run it and
 * when. Actions a module owns are undone by that module's capability instead.
 */
export const INVERSE_EFFECTS: Partial<
	Record<AgentActionType, (env: CloudflareEnv, row: AgentActionRow, userId: string) => Promise<UndoCounts | void>>
> = {
	dismiss: reopenSuggestion,
	create_draft: discardDraft,
	move: undoMove,
	mark_read: undoMarkRead,
	set_folder: undoSetFolder,
	create_folder: undoCreateFolder,
};
