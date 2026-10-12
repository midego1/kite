import { bookingManifest } from "./booking/manifest";
import { calendarManifest } from "./calendar/manifest";
import { importManifest } from "./import/manifest";
import type { ModuleId, ModuleManifest } from "./module-types";
import { templatesManifest } from "./templates/manifest";

/** Fixed order: every surface lists modules in this order. */
export const MODULE_MANIFESTS: readonly ModuleManifest[] = [
	calendarManifest,
	bookingManifest,
	templatesManifest,
	importManifest,
];

/** @public Consumed by tests and the features that wire modules into core surfaces. */
export const MODULE_IDS: readonly ModuleId[] = MODULE_MANIFESTS.map((manifest) => manifest.id);

/** @public Consumed by tests and the features that wire modules into core surfaces. */
export function isModuleId(value: unknown): value is ModuleId {
	return typeof value === "string" && (MODULE_IDS as readonly string[]).includes(value);
}

/** @public Consumed by tests and the features that wire modules into core surfaces. */
export function getModuleManifest(id: ModuleId): ModuleManifest {
	const manifest = MODULE_MANIFESTS.find((item) => item.id === id);
	if (!manifest) throw new Error(`Unknown module ${id}`);
	return manifest;
}

/** The state of a module with no stored setting: its default and that of every dependency. */
export function isEnabledByDefault(id: ModuleId): boolean {
	const manifest = getModuleManifest(id);
	return manifest.defaultEnabled && manifest.dependsOn.every(isEnabledByDefault);
}
