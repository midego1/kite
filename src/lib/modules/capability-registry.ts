import { bookingCapabilities } from "./booking/capabilities";
import { calendarCapabilities } from "./calendar/capabilities";
import { selectCapabilities, type ListedCapability } from "./capability-utils";
import { importCapabilities } from "./import/capabilities";
import type { CapabilityDescriptor, CapabilitySurface, ModuleCapabilities, ModuleId } from "./module-types";
import { templatesCapabilities } from "./templates/capabilities";

/** Same order as `MODULE_MANIFESTS`. */
export const MODULE_CAPABILITIES: readonly ModuleCapabilities[] = [
	calendarCapabilities,
	bookingCapabilities,
	templatesCapabilities,
	importCapabilities,
];

function getModuleCapabilities(moduleId: ModuleId): ModuleCapabilities | undefined {
	return MODULE_CAPABILITIES.find((entry) => entry.moduleId === moduleId);
}

export function findDescriptor(moduleId: ModuleId, name: string): CapabilityDescriptor | undefined {
	return getModuleCapabilities(moduleId)?.descriptors.find((descriptor) => descriptor.name === name);
}

export function listCapabilities(surface: CapabilitySurface, enabled: Iterable<ModuleId>): ListedCapability[] {
	return selectCapabilities(MODULE_CAPABILITIES, surface, enabled);
}
