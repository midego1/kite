import type { ModuleId, ModuleManifest } from "./module-types";
import type { ModuleFlagRow, ModuleFlags } from "./state-types";

type ManifestState = Pick<ModuleManifest, "id" | "dependsOn" | "defaultEnabled">;

/**
 * The flag of every manifest, from stored rows. A module with no row takes `fallback(manifest)`,
 * and rows that name an unknown module (one removed in a later release) are ignored.
 */
export function flagsFromRows(
	rows: readonly ModuleFlagRow[],
	manifests: readonly ManifestState[],
	fallback: (manifest: ManifestState) => boolean,
): ModuleFlags {
	const stored = new Map(rows.map((row) => [row.moduleId, row.flag]));
	return new Map(manifests.map((manifest) => [manifest.id, stored.get(manifest.id) ?? fallback(manifest)]));
}

/**
 * The modules that are on for a viewer: switched on for the install, allowed for the user, and every
 * dependency on in both senses, transitively. A stored flag is never rewritten for this, so Booking
 * comes back with Calendar. Missing entries mean `defaultEnabled` for the install and allowed for access.
 */
export function effectiveModules(
	install: ReadonlyMap<ModuleId, boolean>,
	access: ReadonlyMap<ModuleId, boolean>,
	manifests: readonly ManifestState[],
): Set<ModuleId> {
	const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
	const settled = new Map<ModuleId, boolean>();
	const resolving = new Set<ModuleId>();

	function isOn(id: ModuleId): boolean {
		const known = settled.get(id);
		if (known !== undefined) return known;
		const manifest = byId.get(id);
		// A cycle or an unknown dependency can never be satisfied.
		if (!manifest || resolving.has(id)) return false;
		resolving.add(id);
		const on =
			(install.get(id) ?? manifest.defaultEnabled) && (access.get(id) ?? true) && manifest.dependsOn.every(isOn);
		resolving.delete(id);
		settled.set(id, on);
		return on;
	}

	return new Set(manifests.filter((manifest) => isOn(manifest.id)).map((manifest) => manifest.id));
}

/** D1 reports "no such table: x" inside a `D1_ERROR`, better-sqlite3 as a plain message; Drizzle may wrap either as a cause. */
export function isNoSuchTableError(error: unknown): boolean {
	for (let depth = 0; depth < 5 && error; depth++) {
		const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
		if (/no such table/i.test(message)) return true;
		error = (error as { cause?: unknown }).cause;
	}
	return false;
}
