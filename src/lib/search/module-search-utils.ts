import { isSameOriginPath } from "@/lib/modules/path-utils";
import type { ModuleManifest } from "@/lib/modules/module-types";
import type { ModuleSearchItem, ModuleSearchResult, ModuleSearchSection } from "./module-search-types";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

/** `limit` from the query string: a whole number from 1 to 20, 5 when absent or not a number. */
export function parseSearchLimit(value: string | null): number {
	const parsed = Math.trunc(Number(value));
	if (!value || !Number.isFinite(parsed)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

type Manifests = readonly Pick<ModuleManifest, "id" | "searchSections" | "recordKinds">[];

function safeItems(manifest: Manifests[number], items: readonly ModuleSearchItem[]): ModuleSearchItem[] {
	const kinds = new Set<string>(manifest.recordKinds.map((entry) => entry.kind));
	return items.filter((item) => kinds.has(item.ref.kind) && isSameOriginPath(item.href));
}

/**
 * Turns what the providers answered into response sections. The label comes from the owning module's
 * manifest, and an item stays only when its ref is a record kind the module owns and its link is same-origin.
 * Sections without items are left out.
 */
export function assembleSearchSections(
	manifests: Manifests,
	results: readonly ModuleSearchResult[],
	limit: number,
): ModuleSearchSection[] {
	const sections = new Map<string, ModuleSearchSection>();
	for (const result of results) {
		const manifest = manifests.find((entry) => entry.id === result.moduleId);
		const label = manifest?.searchSections.find((entry) => entry.id === result.section)?.label;
		if (!manifest || !label) continue;
		const items = safeItems(manifest, result.items);
		if (items.length === 0) continue;
		const section = sections.get(result.section) ?? { id: result.section, label, items: [] };
		section.items.push(...items);
		sections.set(result.section, section);
	}
	return [...sections.values()].map((section) => ({ ...section, items: section.items.slice(0, limit) }));
}
