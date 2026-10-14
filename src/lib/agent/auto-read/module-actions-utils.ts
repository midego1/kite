import { MODULE_CAPABILITIES } from "@/lib/modules/capability-registry";
import type { ModuleCapabilities, ModuleId } from "@/lib/modules/module-types";
import { suggestionAnswerers } from "./module-steps-utils";
import type { ActionMeta, ActionUndoRule } from "./actions-types";

/** The same default window the core actions use. */
const DEFAULT_UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ModuleActionOwner = { moduleId: ModuleId; capability: string; reopensSuggestion?: true };

type ModuleActions = {
	meta: Record<string, ActionMeta>;
	owners: Record<string, ModuleActionOwner>;
};

function undoRule(
	action: NonNullable<ModuleCapabilities["descriptors"][number]["action"]>,
	inverse: boolean,
): ActionUndoRule {
	return {
		windowMs: action.undoWindowMs ?? DEFAULT_UNDO_WINDOW_MS,
		permission: action.permission!,
		actingUserOnly: action.actingUserOnly ?? false,
		...(inverse && action.inverseAction
			? { inverseAction: action.inverseAction as ActionUndoRule["inverseAction"] }
			: {}),
	};
}

/**
 * Executor metadata for the action types modules own, read from their `action` descriptors. An
 * action type keeps the string already stored in `agent_actions`, so older rows resolve unchanged.
 * A descriptor that does not state its permission and variants registers nothing.
 * @public Consumed by tests that build a registry from sample descriptors.
 */
export function buildModuleActions(all: readonly ModuleCapabilities[]): ModuleActions {
	const meta: Record<string, ActionMeta> = {};
	const owners: Record<string, ModuleActionOwner> = {};
	for (const entry of all) {
		for (const descriptor of entry.descriptors) {
			const action = descriptor.action;
			if (!descriptor.surfaces.includes("action") || !action?.permission || !action.variants) continue;
			const undo: Record<string, ActionUndoRule | null> = {};
			if (action.undoable) {
				undo["*"] = undoRule(action, true);
				for (const variant of action.inverseSkipVariants ?? []) undo[variant] = undoRule(action, false);
			}
			meta[action.actionType] = { executePermission: action.permission, variants: action.variants, undo };
			owners[action.actionType] = {
				moduleId: entry.moduleId,
				capability: descriptor.name,
				...(action.reopensSuggestion ? { reopensSuggestion: true as const } : {}),
			};
		}
	}
	return { meta, owners };
}

const MODULE_ACTIONS = buildModuleActions(MODULE_CAPABILITIES);

/** Executor metadata of every module action type; loaded whether or not the module is on. */
export const MODULE_ACTION_META: Readonly<Record<string, ActionMeta>> = MODULE_ACTIONS.meta;

/** The module and capability that run an action type, or null for core actions. */
export function moduleActionOwner(actionType: string): ModuleActionOwner | null {
	return MODULE_ACTIONS.owners[actionType] ?? null;
}

/** Every action type a module registers, which together decide whether its suggestion is still answered. */
export function moduleActionTypes(moduleId: ModuleId): string[] {
	return Object.entries(MODULE_ACTIONS.owners)
		.filter(([, owner]) => owner.moduleId === moduleId)
		.map(([actionType]) => actionType);
}

/** The module capability that handles an accept click, per suggestion kind a module owns. */
export const MODULE_ANSWERERS: Readonly<Record<string, ModuleActionOwner>> = suggestionAnswerers(MODULE_CAPABILITIES);
