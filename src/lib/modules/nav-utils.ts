import type { ModuleId, ModuleManifest, ModuleNavItem, ModuleNavPlacement } from "./module-types";

export type ModuleNavEntry = ModuleNavItem & { moduleId: ModuleId };

/**
 * The navigation items modules contribute to one placement, for the modules that are on, ordered by
 * `order` and then by registry order. `enabled` omitted (a client that has not heard from the server
 * yet) lists every module, since the server answers 404 for the ones that are off anyway.
 */
export function moduleNavItems(
	manifests: readonly Pick<ModuleManifest, "id" | "nav">[],
	placement: ModuleNavPlacement,
	enabled?: readonly ModuleId[],
): ModuleNavEntry[] {
	return manifests
		.filter((manifest) => !enabled || enabled.includes(manifest.id))
		.flatMap((manifest) =>
			manifest.nav.filter((item) => item.placement === placement).map((item) => ({ ...item, moduleId: manifest.id })),
		)
		.sort((a, b) => a.order - b.order);
}
