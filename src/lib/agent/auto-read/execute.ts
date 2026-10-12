import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions } from "@/db/schema/agent-auto-read";
import type { SessionUser } from "@/lib/auth/types";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { AgentActionError } from "./action-error";
import { INVERSE_EFFECTS } from "./action-effects";
import { authorizeCreateEventUndo } from "./calendar-undo";
import type { ActionMeta, ActionState, AgentActionRow, ExecuteActionInput, ExecuteActionResult } from "./actions-types";
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
import type { AgentActionType } from "./policy-types";
import { allowedToExecute } from "./policy-utils";
import type { AutonomyLevel } from "./settings-types";

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
	run: { id: string; ids: Record<string, string>; meta: ActionMeta; variant: string; reason: string; resume: boolean },
): Promise<ExecuteActionResult> {
	const now = input.now ?? new Date();
	try {
		const existing = run.resume && input.effect.check ? await input.effect.check(run.ids) : null;
		const after: ActionState = { ...run.ids, ...(existing ?? (await input.effect.apply(run.ids))) };
		await db
			.update(agentActions)
			.set({
				status: "applied",
				after: JSON.stringify(after),
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
	const { refused, rule } = gate(input, meta, variant);
	if (refused || !meta) {
		const reason = refused ?? "action_not_supported";
		const actionId = await recordBlockedAction({ ...input, variant, reason, before: input.effect.before, now });
		return { status: "blocked", actionId, after: null, reason };
	}
	const db = getDb(input.env);
	const ids = input.effect.ids ?? {};
	const id = newId("aact");
	const inserted = await db
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
			variant,
			status: "pending",
			before: json(input.effect.before),
			after: JSON.stringify(ids),
			reason: rule,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: agentActions.id });
	if (inserted.length > 0) return runEffect(db, input, { id, ids, meta, variant, reason: rule, resume: false });

	const live = await findLiveRow(db, input, variant);
	if (live?.status === "applied")
		return { status: "skipped", actionId: live.id, after: parseActionState(live.after), reason: live.reason };
	if (!live || !isStalePending(live.updatedAt, now) || !(await claimStalePending(db, live, now)))
		throw new AgentActionError("This action is already in progress", 409);
	return runEffect(db, input, {
		id: live.id,
		ids: actionIds(parseActionState(live.after)),
		meta,
		variant,
		reason: live.reason ?? rule,
		resume: true,
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

/**
 * Undoes an applied action inside its undo window. Users without full access on the mailbox get 404;
 * a full-access user lacking the permission the undo needs gets 403; anything not applied gets 409 and
 * writes nothing. The original row becomes `undone` and a user-initiated row records the inverse.
 */
export async function undoAgentAction(
	env: CloudflareEnv,
	user: Pick<SessionUser, "id" | "role">,
	actionId: string,
	now = new Date(),
): Promise<{ actionId: string; inverseActionId: string }> {
	const db = getDb(env);
	const [row] = await db.select().from(agentActions).where(eq(agentActions.id, actionId)).limit(1);
	const access = row ? await getMailboxAccessLevel(db, user, row.mailboxId) : null;
	if (!row || !access?.canManage) throw new AgentActionError("Action not found", 404);
	const refusal = undoRefusal(row, user.id, access, now);
	if (refusal) throw new AgentActionError(refusal.error, refusal.status);
	const inverse = INVERSE_EFFECTS[row.action];
	if (!inverse) throw new AgentActionError("This action cannot be undone", 409);
	if (row.action === "create_event") await authorizeCreateEventUndo(env, row, user);

	const claimed = await db
		.update(agentActions)
		.set({ status: "undone", undoneAt: now, undoneByUserId: user.id, updatedAt: now })
		.where(and(eq(agentActions.id, row.id), eq(agentActions.status, "applied")))
		.returning({ id: agentActions.id });
	if (claimed.length === 0) throw new AgentActionError("Only applied actions can be undone", 409);
	try {
		await inverse(env, row, user.id);
	} catch (error) {
		await restoreApplied(db, row.id);
		if (error instanceof AgentActionError) throw error;
		throw new AgentActionError(errorReason(error), 409);
	}
	return { actionId: row.id, inverseActionId: await writeInverseRow(db, row, user.id, now) };
}
