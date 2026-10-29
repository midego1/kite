import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import { getEnv } from "@/lib/cloudflare";
import { MODULE_CAPABILITIES } from "@/lib/modules/capability-registry";
import { bindHostAgentServices } from "@/lib/modules/host";
import type { HostActionCall, HostActionResult, HostSuggestion } from "@/lib/modules/host-types";
import { ownedActionDescriptor, refusedAction } from "@/lib/modules/host-utils";
import type { CapabilityCallContext, JsonValue, ModuleId } from "@/lib/modules/module-types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { AgentActionError } from "./action-error";
import { executeAction } from "./execute";
import { hiddenFromViewer, reviewerOnlySuggestionKinds, suggestionKindOwners } from "./module-steps-utils";
import { notifySuggestionsQuietly } from "./suggestion-events";

const KIND_OWNERS = suggestionKindOwners(MODULE_CAPABILITIES);
const REVIEWER_ONLY_KINDS = reviewerOnlySuggestionKinds(MODULE_CAPABILITIES);

type Viewer = NonNullable<CapabilityCallContext["viewer"]>;

const sessionUser = (viewer: Viewer) =>
	({ id: viewer.userId, role: viewer.role as SessionUser["role"] }) satisfies Pick<SessionUser, "id" | "role">;

/** A mailbox the call is bound to: any mailbox when the context names none, otherwise one of those it names. */
const boundTo = (ctx: CapabilityCallContext, mailboxId: string) =>
	!ctx.mailboxIds || ctx.mailboxIds.includes(mailboxId);

function parsePayload(value: string): JsonValue {
	try {
		return JSON.parse(value) as JsonValue;
	} catch {
		return null;
	}
}

/**
 * A suggestion of a kind the module owns, in any status, when the viewer may decide it: the call is
 * bound to its mailbox, the viewer has full access there, and for a reviewer-only kind is its reviewer.
 */
async function getModuleSuggestion(
	ctx: CapabilityCallContext,
	moduleId: ModuleId,
	suggestionId: string,
): Promise<HostSuggestion | null> {
	if (!ctx.viewer || typeof suggestionId !== "string") return null;
	const db = getDb(getEnv());
	const [row] = await db
		.select({
			id: agentSuggestions.id,
			mailboxId: agentSuggestions.mailboxId,
			messageId: agentSuggestions.messageId,
			kind: agentSuggestions.kind,
			status: agentSuggestions.status,
			payload: agentSuggestions.payload,
			reviewerUserId: agentSuggestions.reviewerUserId,
		})
		.from(agentSuggestions)
		.where(eq(agentSuggestions.id, suggestionId))
		.limit(1);
	if (!row || KIND_OWNERS[row.kind] !== moduleId || !boundTo(ctx, row.mailboxId)) return null;
	if (hiddenFromViewer(row, ctx.viewer.userId, REVIEWER_ONLY_KINDS)) return null;
	if (!(await getMailboxAccessLevel(db, sessionUser(ctx.viewer), row.mailboxId))?.canManage) return null;
	return { ...row, payload: parsePayload(row.payload) };
}

/** Marks an open suggestion the viewer may decide as accepted by them; false when it is not theirs or not open. */
async function decideModuleSuggestion(
	ctx: CapabilityCallContext,
	moduleId: ModuleId,
	suggestionId: string,
	status: "accepted",
): Promise<boolean> {
	if (status !== "accepted") return false;
	const suggestion = await getModuleSuggestion(ctx, moduleId, suggestionId);
	if (!suggestion || suggestion.status !== "open") return false;
	const env = getEnv();
	const updated = await getDb(env)
		.update(agentSuggestions)
		.set({ status: "accepted", decidedAt: new Date(), decidedByUserId: ctx.viewer!.userId })
		.where(and(eq(agentSuggestions.id, suggestion.id), eq(agentSuggestions.status, "open")))
		.returning({ id: agentSuggestions.id });
	if (updated.length === 0) return false;
	await notifySuggestionsQuietly(env, [suggestion.id]);
	return true;
}

/** The suggestion and message the call names, checked against its mailbox; null when either is not there. */
async function callTargets(
	ctx: CapabilityCallContext,
	moduleId: ModuleId,
	call: HostActionCall,
): Promise<{ suggestionId: string | null; messageId: string | null } | null> {
	let messageId = call.messageId ?? null;
	if (call.suggestionId) {
		const suggestion = await getModuleSuggestion(ctx, moduleId, call.suggestionId);
		if (!suggestion || suggestion.mailboxId !== call.mailboxId) return null;
		messageId ??= suggestion.messageId;
	}
	if (messageId) {
		const [message] = await getDb(getEnv())
			.select({ id: messages.id, status: messages.status, userId: messages.userId })
			.from(messages)
			.where(and(eq(messages.id, messageId), eq(messages.mailboxId, call.mailboxId)))
			.limit(1);
		if (!message || isHiddenDraft(message, ctx.viewer!.userId)) return null;
	}
	return { suggestionId: call.suggestionId ?? null, messageId };
}

/**
 * Runs one of the module's own action capabilities through the executor as the viewer (initiator
 * `user`), with the viewer's permissions on the mailbox. Another module's action is refused with 403;
 * an unknown action, a mailbox the call is not bound to or the viewer cannot reach, and a suggestion or
 * message outside it answer 404; a refusal by the executor 403 or 409.
 */
async function executeModuleAction(
	ctx: CapabilityCallContext,
	moduleId: ModuleId,
	call: HostActionCall,
): Promise<HostActionResult> {
	if (!ctx.viewer) return { ok: false, status: 403, error: "Actions need an acting user" };
	const descriptor = ownedActionDescriptor(MODULE_CAPABILITIES, moduleId, call.capability);
	if ("status" in descriptor) return { ok: false, ...descriptor };
	const env = getEnv();
	const access = boundTo(ctx, call.mailboxId)
		? await getMailboxAccessLevel(getDb(env), sessionUser(ctx.viewer), call.mailboxId)
		: null;
	if (!access) return { ok: false, status: 404, error: "Mailbox not found" };
	const targets = await callTargets(ctx, moduleId, call);
	if (!targets) return { ok: false, status: 404, error: "Suggestion or message not found" };
	try {
		const result = await executeAction({
			env,
			mailboxId: call.mailboxId,
			...targets,
			action: descriptor.action.actionType,
			variant: call.variant ?? "",
			initiator: "user",
			actingUserId: ctx.viewer.userId,
			permissions: { canRead: access.canRead, canManage: access.canManage, canSendOnBehalf: access.canSendOnBehalf },
			module: {
				input: call.input,
				...(call.before === undefined ? {} : { before: call.before }),
				viewer: { ...ctx.viewer, timeZone: normalizeTimeZone(ctx.timeZone) },
			},
		});
		if (result.status === "applied" || result.status === "skipped")
			return { ok: true, actionId: result.actionId, result: (result.after ?? {}) as JsonValue };
		return refusedAction(result.reason);
	} catch (error) {
		if (error instanceof AgentActionError)
			return {
				ok: false,
				status: error.status === 403 || error.status === 404 ? error.status : 409,
				error: error.message,
			};
		throw error;
	}
}

bindHostAgentServices({
	getSuggestion: getModuleSuggestion,
	decideSuggestion: decideModuleSuggestion,
	executeAction: executeModuleAction,
});
