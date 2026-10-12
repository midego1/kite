import type { ModuleId, ModuleManifest } from "./module-types";

/**
 * Statuses a message list must filter out. Every status a module owns is excluded, except the one that was
 * asked for while its module is on for the viewer. Asking for it while the module is off still excludes it,
 * so the list is empty.
 */
export function messageStatusExclusions(
	manifests: readonly Pick<ModuleManifest, "id" | "messageStatuses">[],
	requested: string | null,
	enabled: Iterable<ModuleId>,
): string[] {
	const on = new Set(enabled);
	return [
		...new Set(
			manifests.flatMap((manifest) =>
				manifest.messageStatuses.filter((status) => !(status === requested && on.has(manifest.id))),
			),
		),
	];
}
