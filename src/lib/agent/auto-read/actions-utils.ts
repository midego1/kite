import type {
	ActionMeta,
	ActionPermission,
	ActionPermissions,
	ActionUndoRule,
	AgentActionRow,
	UndoRefusal,
} from "./actions-types";
import { MODULE_ACTION_META } from "./module-actions-utils";
import type { AgentActionType } from "./policy-types";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const DEFAULT_UNDO_WINDOW_MS = 7 * DAY_MS;
/** A pending row older than this was left by a crash and may be taken over. */
const STALE_PENDING_MS = 10 * MINUTE_MS;
/** Inverse rows carry `undo:<original id>`, so each undo stays unique under the live-row index. */
export const UNDO_VARIANT_PREFIX = "undo:";

/** Executor metadata of the actions core owns; modules register theirs from their `action` descriptors. */
const CORE_ACTIONS: Partial<Record<AgentActionType, ActionMeta>> = {
	// Inverse: reopen the suggestion.
	dismiss: {
		executePermission: "manage",
		variants: [""],
		undo: { "*": { windowMs: DEFAULT_UNDO_WINDOW_MS, permission: "manage", actingUserOnly: false } },
	},
	// "Mark as spam" from a phishing warning. Inverse: move the message back and reopen the warning.
	move: {
		executePermission: "manage",
		variants: ["spam"],
		undo: { "*": { windowMs: DEFAULT_UNDO_WINDOW_MS, permission: "manage", actingUserOnly: false } },
	},
	// Inverse: discard the draft, unless a person edited or sent it. Drafts are private to their user.
	create_draft: {
		executePermission: "send_on_behalf",
		variants: [""],
		undo: { "*": { windowMs: DEFAULT_UNDO_WINDOW_MS, permission: "send_on_behalf", actingUserOnly: true } },
	},
};

/**
 * Executor metadata per action type. An action type missing here cannot be executed, and the module
 * ones stay listed while their module is off so older rows keep their labels and undo rules.
 */
export const ACTION_REGISTRY: Partial<Record<AgentActionType, ActionMeta>> = { ...CORE_ACTIONS, ...MODULE_ACTION_META };

export function getActionMeta(action: string): ActionMeta | null {
	return ACTION_REGISTRY[action as AgentActionType] ?? null;
}

export function getUndoRule(meta: ActionMeta, variant: string): ActionUndoRule | null {
	// An inverse row records an undo; undoing it again is a new action, not an undo of the undo.
	if (variant.startsWith(UNDO_VARIANT_PREFIX)) return null;
	return variant in meta.undo ? (meta.undo[variant] ?? null) : (meta.undo["*"] ?? null);
}

function hasActionPermission(permissions: ActionPermissions, permission: ActionPermission): boolean {
	return permission === "manage" ? permissions.canManage : permissions.canSendOnBehalf;
}

/** The policy reason recorded when a user click lacks the permission an action needs, or null. */
export function userExecuteRefusal(
	meta: ActionMeta | null,
	variant: string,
	permissions: ActionPermissions,
): string | null {
	if (!meta) return "action_not_supported";
	if (!meta.variants.includes(variant)) return "variant_not_supported";
	return hasActionPermission(permissions, meta.executePermission) ? null : `missing_${meta.executePermission}`;
}

export function undoUntilFor(meta: ActionMeta, variant: string, now: Date): Date | null {
	const rule = getUndoRule(meta, variant);
	return rule ? new Date(now.getTime() + rule.windowMs) : null;
}

export function isStalePending(updatedAt: Date, now: Date): boolean {
	return now.getTime() - updatedAt.getTime() > STALE_PENDING_MS;
}

/** Why an undo is refused, or null when it may run. The caller has already checked full access. */
export function undoRefusal(
	row: Pick<AgentActionRow, "action" | "variant" | "status" | "undoUntil" | "actingUserId">,
	userId: string,
	permissions: ActionPermissions,
	now: Date,
): UndoRefusal | null {
	const meta = getActionMeta(row.action);
	const rule = meta ? getUndoRule(meta, row.variant) : null;
	if (!rule) return { status: 409, error: "This action cannot be undone" };
	if (row.status !== "applied") return { status: 409, error: "Only applied actions can be undone" };
	if (!row.undoUntil || row.undoUntil.getTime() <= now.getTime())
		return { status: 409, error: "The undo window has passed" };
	if (!hasActionPermission(permissions, rule.permission))
		return { status: 403, error: "You do not have permission to undo this action" };
	if (rule.actingUserOnly && row.actingUserId !== userId)
		return { status: 403, error: "Only the user who ran this action can undo it" };
	return null;
}

export function inverseActionFor(row: Pick<AgentActionRow, "action" | "variant">): AgentActionType {
	const meta = getActionMeta(row.action);
	const rule = meta ? getUndoRule(meta, row.variant) : null;
	return rule?.inverseAction ?? row.action;
}

export function parseActionState(value: string | null): Record<string, unknown> | null {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The string ids an effect stored in its row, used to resume it. */
export function actionIds(state: Record<string, unknown> | null): Record<string, string> {
	const ids: Record<string, string> = {};
	for (const [key, value] of Object.entries(state ?? {})) if (typeof value === "string") ids[key] = value;
	return ids;
}

/** Whether the Activity view may offer Undo for a row. */
export function canOfferUndo(row: Pick<AgentActionRow, "action" | "variant" | "status" | "undoUntil">, now: Date) {
	const meta = getActionMeta(row.action);
	return (
		!!meta &&
		!!getUndoRule(meta, row.variant) &&
		row.status === "applied" &&
		!!row.undoUntil &&
		row.undoUntil.getTime() > now.getTime()
	);
}

/** The original action id for an inverse row, or null. */
function undoneActionId(variant: string): string | null {
	return variant.startsWith(UNDO_VARIANT_PREFIX) ? variant.slice(UNDO_VARIANT_PREFIX.length) || null : null;
}

/** The audit row as the Activity API returns it; `before` stays server-side. */
export function toActivityAction(row: AgentActionRow, now: Date) {
	return {
		id: row.id,
		initiator: row.initiator,
		action: row.action,
		variant: undoneActionId(row.variant) ? "" : row.variant,
		undoOf: undoneActionId(row.variant),
		status: row.status,
		reason: row.reason,
		suggestionId: row.suggestionId,
		messageId: row.messageId,
		actingUserId: row.actingUserId,
		autonomy: row.autonomy,
		after: parseActionState(row.after),
		undoUntil: row.undoUntil?.toISOString() ?? null,
		undoneAt: row.undoneAt?.toISOString() ?? null,
		undoneByUserId: row.undoneByUserId,
		createdAt: row.createdAt.toISOString(),
		canUndo: canOfferUndo(row, now),
	};
}
