import type { ComposerSlotDeclaration, ComposerSlotSource, ListedComposerSlot, ModuleId } from "./module-types";

/**
 * The slots of one placement that enabled modules declare, ordered by `order` and then by module order.
 * Nothing enabled declares one: an empty list, so the composer draws no entry and no separator.
 */
export function listComposerSlots(
	modules: readonly ComposerSlotSource[],
	enabled: Iterable<ModuleId>,
	placement: ComposerSlotDeclaration["slot"],
): ListedComposerSlot[] {
	const on = new Set(enabled);
	return modules
		.filter((module) => on.has(module.id))
		.flatMap((module) =>
			(module.composerSlots ?? [])
				.filter((slot) => slot.slot === placement)
				.map((slot) => ({ ...slot, moduleId: module.id })),
		)
		.sort((a, b) => a.order - b.order);
}

/** The slots whose client chunk to request now: none until the menu has been opened once. */
export function slotsToLoad(slots: readonly ListedComposerSlot[], opened: boolean): readonly ListedComposerSlot[] {
	return opened ? slots : [];
}
