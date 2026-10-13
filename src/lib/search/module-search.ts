import { listCapabilities } from "@/lib/modules/capability-registry";
import { buildCallContext } from "@/lib/modules/capability-utils";
import { invokeCapability } from "@/lib/modules/invoke";
import type { JsonValue } from "@/lib/modules/module-types";
import { MODULE_MANIFESTS } from "@/lib/modules/registry";
import { listEnabledModules } from "@/lib/modules/state";
import { assembleSearchSections } from "./module-search-utils";
import type { ModuleSearchItem, ModuleSearchResult, ModuleSearchSection } from "./module-search-types";

type SearchViewer = { id: string; role: string; isPrimaryAdmin: boolean };

function isItems(value: JsonValue): value is { items: ModuleSearchItem[] } {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray(value.items);
}

/**
 * Asks every `search` capability of the modules enabled for the viewer, in parallel. A provider that fails
 * (the invoker has logged why) drops its own section and leaves the others. Mail results are not here:
 * they stay on the message list path.
 */
export async function searchModules(
	env: CloudflareEnv,
	user: SearchViewer,
	query: string,
	limit: number,
	timeZone: string,
): Promise<ModuleSearchSection[]> {
	const viewer = { userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin };
	const enabled = await listEnabledModules(env, viewer);
	const providers = listCapabilities("search", enabled);
	if (providers.length === 0) return [];
	const ctx = buildCallContext({ trigger: "api", viewer, timeZone, enabled, manifests: MODULE_MANIFESTS });
	const answers = await Promise.all(
		providers.map(async ({ moduleId, descriptor }): Promise<ModuleSearchResult | null> => {
			const section = descriptor.search?.section;
			if (!section) return null;
			const result = await invokeCapability(moduleId, descriptor.name, { query, limit }, ctx);
			return result.ok && isItems(result.output) ? { moduleId, section, items: result.output.items } : null;
		}),
	);
	return assembleSearchSections(
		MODULE_MANIFESTS,
		answers.filter((answer) => answer !== null),
		limit,
	);
}
