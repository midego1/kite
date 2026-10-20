import { MODULE_IDS } from "./client-data/module-ids";
import { bookingManifest } from "./booking/manifest";
import { calendarManifest } from "./calendar/manifest";
import { driveManifest } from "./drive/manifest";
import { financeManifest } from "./finance/manifest";
import { importManifest } from "./import/manifest";
import type { ModuleId, ModuleManifest } from "./module-types";
import { templatesManifest } from "./templates/manifest";

/** Fixed order: every surface lists modules in this order. */
export const MODULE_MANIFESTS: readonly ModuleManifest[] = [
	calendarManifest,
	bookingManifest,
	templatesManifest,
	importManifest,
	financeManifest,
	driveManifest,
];

export { MODULE_IDS };

export function isModuleId(value: unknown): value is ModuleId {
	return typeof value === "string" && (MODULE_IDS as readonly string[]).includes(value);
}

/** @public Test-only: production code reads `MODULE_MANIFESTS`. */
export function getModuleManifest(id: ModuleId): ModuleManifest {
	const manifest = MODULE_MANIFESTS.find((item) => item.id === id);
	if (!manifest) throw new Error(`Unknown module ${id}`);
	return manifest;
}

/** The message statuses modules own; they never show in ordinary lists. */
export function moduleOwnedMessageStatuses(): string[] {
	return [...new Set(MODULE_MANIFESTS.flatMap((manifest) => manifest.messageStatuses))];
}
