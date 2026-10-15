import { MODULE_CAPABILITIES } from "@/lib/modules/capability-registry";
import { capabilityInputSchema } from "@/lib/modules/invoke";
import { suggestionKindDescriptors } from "./module-steps-utils";

const MODULE_KINDS = suggestionKindDescriptors(MODULE_CAPABILITIES);

function ownerOf(kind: string) {
	return Object.hasOwn(MODULE_KINDS, kind) ? MODULE_KINDS[kind] : null;
}

/** The payload schema of a module-owned kind: the input schema of the `suggestion_kind` descriptor that declares it. */
export function moduleKindPayloadSchema(kind: string) {
	const owner = ownerOf(kind);
	return owner ? capabilityInputSchema(owner.moduleId, owner.capability) : null;
}

/** The descriptor's label of a module-owned kind, the title of a suggestion whose step supplied none. */
export function moduleKindLabel(kind: string): string | null {
	return ownerOf(kind)?.label ?? null;
}
