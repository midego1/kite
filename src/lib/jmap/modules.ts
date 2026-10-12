import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import { MODULE_CAPABILITIES } from "@/lib/modules/capability-registry";
import { buildCallContext } from "@/lib/modules/capability-utils";
import { invokeCapability } from "@/lib/modules/invoke";
import { MODULE_MANIFESTS } from "@/lib/modules/registry";
import { listEnabledModules } from "@/lib/modules/state";
import { normalizeTimeZone } from "@/lib/time/utils";
import { jmapModuleSurface, NO_JMAP_MODULES } from "./module-utils";
import type { JmapModuleSurface } from "./types";

const declaresJmap = MODULE_CAPABILITIES.some((entry) =>
	entry.descriptors.some(
		(descriptor) => descriptor.surfaces.includes("jmap_capability") || descriptor.surfaces.includes("jmap_method"),
	),
);

/**
 * What the modules enabled for the key's user add to this request's session and method table.
 * With no module declaring JMAP (today's builtin modules) it reads no module state at all.
 */
export async function loadJmapModules(env: CloudflareEnv, auth: ApiAuthResult): Promise<JmapModuleSurface> {
	if (!declaresJmap) return NO_JMAP_MODULES;
	const viewer = { userId: auth.user.id, role: auth.user.role, isPrimaryAdmin: auth.user.isPrimaryAdmin };
	const enabled = await listEnabledModules(env, viewer);
	const context = buildCallContext({
		trigger: "api",
		viewer,
		timeZone: normalizeTimeZone(auth.user.timeZone),
		enabled,
		manifests: MODULE_MANIFESTS,
		...(auth.mailboxIds ? { mailboxIds: auth.mailboxIds } : {}),
	});
	return jmapModuleSurface(MODULE_CAPABILITIES, enabled, (moduleId, name, input) =>
		invokeCapability(moduleId, name, input, context),
	);
}
