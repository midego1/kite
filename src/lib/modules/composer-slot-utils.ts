import type {
	ComposerSlotDeclaration,
	ComposerSlotSource,
	ListedComposerSlot,
	ListedMessageSlot,
	MessageSlotDeclaration,
	MessageSlotSource,
	ModuleId,
} from "./module-types";

type SlotDeclaration = { slot: string; order: number };

function listSlots<S extends { id: ModuleId }, T extends SlotDeclaration>(
	modules: readonly S[],
	declared: (module: S) => readonly T[] | undefined,
	enabled: Iterable<ModuleId>,
	placement: string,
): (T & { moduleId: ModuleId })[] {
	const on = new Set(enabled);
	return modules
		.filter((module) => on.has(module.id))
		.flatMap((module) =>
			(declared(module) ?? [])
				.filter((slot) => slot.slot === placement)
				.map((slot) => ({ ...slot, moduleId: module.id })),
		)
		.sort((a, b) => a.order - b.order);
}

/**
 * The slots of one placement that enabled modules declare, ordered by `order` and then by module order.
 * Nothing enabled declares one: an empty list, so the composer draws no entry and no separator.
 */
export function listComposerSlots(
	modules: readonly ComposerSlotSource[],
	enabled: Iterable<ModuleId>,
	placement: ComposerSlotDeclaration["slot"],
): ListedComposerSlot[] {
	return listSlots(modules, (module) => module.composerSlots, enabled, placement);
}

/** The reader menu entries enabled modules declare, in the same order as composer slots. */
export function listMessageSlots(
	modules: readonly MessageSlotSource[],
	enabled: Iterable<ModuleId>,
	placement: MessageSlotDeclaration["slot"],
): ListedMessageSlot[] {
	return listSlots(modules, (module) => module.messageSlots, enabled, placement);
}

/** The slots whose client chunk to request now: none until the menu has been opened once. */
export function slotsToLoad<T>(slots: readonly T[], opened: boolean): readonly T[] {
	return opened ? slots : [];
}
