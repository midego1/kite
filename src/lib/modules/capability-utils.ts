import type { CapabilityDescriptor, CapabilitySurface, ModuleCapabilities, ModuleId } from "./module-types";

/** Surfaces that only declare something; core never invokes them. */
const DECLARATION_ONLY: readonly CapabilitySurface[] = ["webhook_event", "suggestion_kind", "jmap_capability"];

/** @public Consumed by tests and the features that wire modules into core surfaces. */
export function isInvokableDescriptor(descriptor: Pick<CapabilityDescriptor, "surfaces">): boolean {
	return descriptor.surfaces.some((surface) => !DECLARATION_ONLY.includes(surface));
}

/** Only the two tool surfaces describe the same call, so only they may share a descriptor. */
/** @public Consumed by tests and the features that wire modules into core surfaces. */
export function surfacesAreCombinable(surfaces: readonly CapabilitySurface[]): boolean {
	if (surfaces.length === 0) return false;
	if (new Set(surfaces).size !== surfaces.length) return false;
	return surfaces.length === 1 || surfaces.every((surface) => surface === "assistant_tool" || surface === "mcp_tool");
}

export type ListedCapability = { moduleId: ModuleId; descriptor: CapabilityDescriptor };

/** The descriptors for one surface from the enabled modules, in registry order. */
export function selectCapabilities(
	all: readonly ModuleCapabilities[],
	surface: CapabilitySurface,
	enabled: Iterable<ModuleId>,
): ListedCapability[] {
	const on = new Set(enabled);
	return all.flatMap((entry) =>
		on.has(entry.moduleId)
			? entry.descriptors
					.filter((descriptor) => descriptor.surfaces.includes(surface))
					.map((descriptor) => ({ moduleId: entry.moduleId, descriptor }))
			: [],
	);
}
