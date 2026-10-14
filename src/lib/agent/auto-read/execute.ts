import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions } from "@/db/schema/agent-auto-read";
import type { SessionUser } from "@/lib/auth/types";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { AgentActionError } from "./action-error";
import { moduleDisabledError } from "./action-response";
import { INVERSE_EFFECTS } from "./action-effects";
import type {
	ActionEffect,
	ActionMeta,
	ActionState,
	AgentActionRow,
	ExecuteActionInput,
	ExecuteActionResult,
	ModuleActionViewer,
} from "./actions-types";
import {
	UNDO_VARIANT_PREFIX,
	actionIds,
	getActionMeta,
	inverseActionFor,
	isStalePending,
	parseActionState,
	undoRefusal,
	undoUntilFor,
	userExecuteRefusal,
} from "./actions-utils";
import { moduleActionOwner, moduleActionTypes, type ModuleActionOwner } from "./module-actions-utils";
import { moduleEffect, moduleOffReason, undoModuleAction } from "./module-actions";
import type { AgentActionType } from "./policy-types";
import { allowedToExecute } from "./policy-utils";
import { reopenSuggestionIfIdle } from "./suggestion-reopen";
import type { AutonomyLevel } from "./settings-types";
import { normalizeTimeZone } from "@/lib/time/utils";

type Db = ReturnType<typeof getDb>;

const USER_CLICK_REASON = "user_click";
const UNDO_REASON = "undo";
const MAX_REASON_CHARS = 200;

function json(value: unknown): string | null {
	return value === undefined || value === null ? null : JSON.stringify(value);
}

function errorReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, MAX_REASON_CHARS) || "failed";
}

type RecordBlockedInput = {
	env: CloudflareEnv;
	mailboxId: string;
	suggestionId?: string | null;
	messageId?: string | null;
	jobId?: string | null;
	action: AgentActionType;
	variant?: string;
	initiator: "agent" | "user";
	actingUserId: string;
	autonomy?: AutonomyLevel | null;
	reason: string;
	before?: unknown;
	now?: Date;
};

/** Writes a `blocked` row for an action policy refused; blocked rows never collide with live ones. */
export async function recordBlockedAction(input: RecordBlockedInput): Promise<string> {
	const id = newId("aact");
	const now = input.now ?? new Date();
	await getDb(input.env)
		.insert(agentActions)
		.values({
			id,
			mailboxId: input.mailboxId,
			suggestionId: input.suggestionId ?? null,
			messageId: input.messageId ?? null,
			jobId: input.jobId ?? null,
			initiator: input.initiator,
			actingUserId: input.actingUserId,
			autonomy: input.autonomy ?? null,
			action: input.action,
			variant: input.variant ?? "",
			status: "blocked",
			before: json(input.before),
			reason: input.reason,
			createdAt: now,
			updatedAt: now,
		});
	return id;
}

/** The policy rule that refuses this call, or null, plus the rule recorded when it is allowed. */
function gate(input: ExecuteActionInput, meta: ActionMeta | null, variant: string) {
	if (input.initiator === "user")
		return { refused: userExecuteRefusal(meta, variant, input.permissions), rule: USER_CLICK_REASON };
	if (!meta) return { refused: "action_not_supported", rule: "" };
	const { level, facts, senderPolicy, context } = input.gate;
	const decision = allowedToExecute(level, input.action, facts, senderPolicy, context);
	return { refused: decision.allowed ? null : decision.rule, rule: decision.rule };
}

async function findLiveRow(db: Db, input: ExecuteActionInput, variant: string): Promise<AgentActionRow | null> {
	const [row] = await db
		.select()
		.from(agentActions)
		.where(
			and(
				input.suggestionId ? eq(agentActions.suggestionId, input.suggestionId) : isNull(agentActions.suggestionId),
				eq(agentActions.action, input.action),
				eq(agentActions.variant, variant),
				inArray(agentActions.status, ["pending", "applied"]),
			),
		)
		.limit(1);
	return row ?? null;
}

async function runEffect(
	db: Db,
	input: ExecuteActionInput,
	run: {
		id: string;
		effect: ActionEffect;
		ids: Record<string, string>;
		meta: ActionMeta;
		variant: string;
		reason: string;
		resume: boolean;
	},
): Promise<ExecuteActionResult> {
	const now = input.now ?? new Date();
	const { effect } = run;
	try {
		const existing = run.resume && effect.check ? await effect.check(run.ids) : null;
		const after: ActionState = { ...run.ids, ...(existing ?? (await effect.apply(run.ids))) };
		const inverse = effect.takeInverse?.() ?? null;
		await db
			.update(agentActions)
			.set({
				status: "applied",
				after: JSON.stringify(after),
				...(inverse === null ? {} : { before: JSON.stringify(inverse) }),
				undoUntil: undoUntilFor(run.meta, run.variant, now),
				updatedAt: new Date(),
			})
			.where(eq(agentActions.id, run.id));
		return { status: "applied", actionId: run.id, after, reason: run.reason };
	} catch (error) {
		const reason = errorReason(error);
		await db
			.update(agentActions)
			.set({ status: "failed", reason, updatedAt: new Date() })
			.where(eq(agentActions.id, run.id));
		return { status: "failed", actionId: run.id, after: null, reason };
	}
}

/** Takes over a pending row left by a crash; only one caller wins the conditional update. */
async function claimStalePending(db: Db, row: AgentActionRow, now: Date): Promise<boolean> {
	const claimed = await db
		.update(agentActions)
		.set({ updatedAt: now })
		.where(
			and(eq(agentActions.id, row.id), eq(agentActions.status, "pending"), eq(agentActions.updatedAt, row.updatedAt)),
		)
		.returning({ id: agentActions.id });
	return claimed.length > 0;
}

/**
 * Runs one action with its audit row written first. The row is `pending` before the side effect and
 * becomes `applied` or `failed` after it. A live row for the same suggestion, action and variant makes
 * the call idempotent: an applied row is skipped, a fresh pending row is a conflict (HTTP 409), and a
 * pending row older than ten minutes is resumed with its stored ids so the effect never runs twice.
 */
export async function executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
	const now = input.now ?? new Date();
	const variant = input.variant ?? "";
	const meta = getActionMeta(input.action);
	const owner = input.module ? moduleActionOwner(input.action) : null;
	const { refused, rule } = await refusalFor(input, meta, owner, variant);
	if (refused || !meta) {
		const reason = refused ?? "action_not_supported";
		const actionId = await recordBlockedAction({ ...input, variant, reason, before: input.effect?.before, now });
		return { status: "blocked", actionId, after: null, reason };
	}
	const db = getDb(input.env);
	const ids = input.effect?.ids ?? {};
	const id = newId("aact");
	if (await insertPending(db, input, { id, variant, rule, ids, now }))
		return runEffect(db, input, {
			id,
			effect: effectFor(input, owner, id),
			ids,
			meta,
			variant,
			reason: rule,
			resume: false,
		});

	const live = await findLiveRow(db, input, variant);
	if (live?.status === "applied")
		return { status: "skipped", actionId: live.id, after: parseActionState(live.after), reason: live.reason };
	if (!live || !isStalePending(live.updatedAt, now) || !(await claimStalePending(db, live, now)))
		throw new AgentActionError("This action is already in progress", 409);
	return runEffect(db, input, {
		id: live.id,
		effect: effectFor(input, owner, live.id),
		ids: actionIds(parseActionState(live.after)),
		meta,
		variant,
		reason: live.reason ?? rule,
		resume: true,
	});
}

/** The reason this call is refused (policy, an unsupported action or its module being off), or null. */
async function refusalFor(
	input: ExecuteActionInput,
	meta: ActionMeta | null,
	owner: ModuleActionOwner | null,
	variant: string,
): Promise<{ refused: string | null; rule: string }> {
	const { refused, rule } = gate(input, meta, variant);
	if (refused) return { refused, rule };
	if (!meta || (input.module && !owner)) return { refused: "action_not_supported", rule };
	const offReason = input.module && owner ? await moduleOffReason(input.module.viewer, owner) : null;
	return { refused: offReason, rule };
}

/** Writes the pending row ahead of the effect; false when a live row for the same action already exists. */
async function insertPending(
	db: Db,
	input: ExecuteActionInput,
	row: { id: string; variant: string; rule: string; ids: Record<string, string>; now: Date },
): Promise<boolean> {
	const inserted = await db
		.insert(agentActions)
		.values({
			id: row.id,
			mailboxId: input.mailboxId,
			suggestionId: input.suggestionId ?? null,
			messageId: input.messageId ?? null,
			jobId: input.jobId ?? null,
			initiator: input.initiator,
			actingUserId: input.actingUserId,
			autonomy: input.autonomy ?? null,
			action: input.action,
			variant: row.variant,
			status: "pending",
			before: json(input.effect ? input.effect.before : input.module?.before),
			after: JSON.stringify(row.ids),
			reason: row.rule,
			createdAt: row.now,
			updatedAt: row.now,
		})
		.onConflictDoNothing()
		.returning({ id: agentActions.id });
	return inserted.length > 0;
}

/** The caller's effect, or the module capability that performs this action under the row's id. */
function effectFor(input: ExecuteActionInput, owner: ModuleActionOwner | null, actionId: string): ActionEffect {
	if (input.effect) return input.effect;
	return moduleEffect({
		owner: owner!,
		viewer: input.module!.viewer,
		actionId,
		mailboxId: input.mailboxId,
		suggestion: { id: input.suggestionId ?? null, messageId: input.messageId ?? null, mailboxId: input.mailboxId },
		args: input.module!.input,
	});
}

async function restoreApplied(db: Db, id: string): Promise<void> {
	await db
		.update(agentActions)
		.set({ status: "applied", undoneAt: null, undoneByUserId: null, updatedAt: new Date() })
		.where(eq(agentActions.id, id));
}

async function writeInverseRow(db: Db, row: AgentActionRow, userId: string, now: Date): Promise<string> {
	const id = newId("aact");
	await db.insert(agentActions).values({
		id,
		mailboxId: row.mailboxId,
		suggestionId: row.suggestionId,
		messageId: row.messageId,
		jobId: row.jobId,
		initiator: "user",
		actingUserId: userId,
		autonomy: row.autonomy,
		action: inverseActionFor(row),
		variant: `${UNDO_VARIANT_PREFIX}${row.id}`,
		status: "applied",
		before: row.after,
		after: row.before,
		reason: UNDO_REASON,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

/** A module action that declares `reopensSuggestion` reopens its suggestion once none of the module's actions is live. */
async function reopenAfterUndo(
	env: CloudflareEnv,
	suggestionId: string | null,
	owner: ModuleActionOwner | null,
): Promise<void> {
	if (owner?.reopensSuggestion) await reopenSuggestionIfIdle(env, suggestionId, moduleActionTypes(owner.moduleId));
}

type UndoActor = Pick<SessionUser, "id" | "role"> & Partial<Pick<SessionUser, "isPrimaryAdmin" | "timeZone">>;

function undoViewer(user: UndoActor): ModuleActionViewer {
	return {
		userId: user.id,
		role: user.role,
		isPrimaryAdmin: user.isPrimaryAdmin ?? false,
		timeZone: normalizeTimeZone(user.timeZone ?? null),
	};
}

/**
 * Undoes an applied action inside its undo window. Users without full access on the mailbox get 404;
 * a full-access user lacking the permission the undo needs gets 403; anything not applied gets 409 and
 * writes nothing. The original row becomes `undone` and a user-initiated row records the inverse.
 */
export async function undoAgentAction(
	env: CloudflareEnv,
	user: UndoActor,
	actionId: string,
	now = new Date(),
): Promise<{ actionId: string; inverseActionId: string }> {
	const db = getDb(env);
	const [row] = await db.select().from(agentActions).where(eq(agentActions.id, actionId)).limit(1);
	const access = row ? await getMailboxAccessLevel(db, user, row.mailboxId) : null;
	if (!row || !access?.canManage) throw new AgentActionError("Action not found", 404);
	const refusal = undoRefusal(row, user.id, access, now);
	if (refusal) throw new AgentActionError(refusal.error, refusal.status);
	const owner = moduleActionOwner(row.action);
	const inverse = INVERSE_EFFECTS[row.action];
	if (!owner && !inverse) throw new AgentActionError("This action cannot be undone", 409);
	const viewer = owner ? undoViewer(user) : null;
	const offReason = owner && viewer ? await moduleOffReason(viewer, owner) : null;
	if (offReason) {
		await recordBlockedAction({
			env,
			mailboxId: row.mailboxId,
			suggestionId: row.suggestionId,
			messageId: row.messageId,
			action: inverseActionFor(row),
			variant: `${UNDO_VARIANT_PREFIX}${row.id}`,
			initiator: "user",
			actingUserId: user.id,
			reason: offReason,
			now,
		});
		throw moduleDisabledError(offReason);
	}
	if (owner && viewer) await undoModuleAction(owner, viewer, row, true);

	const claimed = await db
		.update(agentActions)
		.set({ status: "undone", undoneAt: now, undoneByUserId: user.id, updatedAt: now })
		.where(and(eq(agentActions.id, row.id), eq(agentActions.status, "applied")))
		.returning({ id: agentActions.id });
	if (claimed.length === 0) throw new AgentActionError("Only applied actions can be undone", 409);
	try {
		if (owner && viewer) await undoModuleAction(owner, viewer, row);
		else await inverse!(env, row, user.id);
	} catch (error) {
		await restoreApplied(db, row.id);
		if (error instanceof AgentActionError) throw error;
		throw new AgentActionError(errorReason(error), 409);
	}
	const inverseActionId = await writeInverseRow(db, row, user.id, now);
	await reopenAfterUndo(env, row.suggestionId, owner);
	return { actionId: row.id, inverseActionId };
}
