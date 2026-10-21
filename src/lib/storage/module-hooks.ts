import { MODULE_CAPABILITIES } from "@/lib/modules/capability-registry";
import { invokeCapability } from "@/lib/modules/invoke";
import type { CapabilityCallContext, JsonValue, StorageHookName } from "@/lib/modules/module-types";

const SYSTEM_CONTEXT: CapabilityCallContext = {
	viewer: null,
	requestId: "storage",
	locale: "en",
	timeZone: "UTC",
	grants: [],
	trigger: "system",
};

export class StorageHookError extends Error {}

/** The module capability that answers a storage hook for an object class, when a module owns that class. */
function hookFor(objectClass: string, hook: StorageHookName) {
	for (const entry of MODULE_CAPABILITIES) {
		const descriptor = entry.descriptors.find(
			(item) => item.storage?.objectClass === objectClass && item.storage.hook === hook,
		);
		if (descriptor) return { moduleId: entry.moduleId, name: descriptor.name };
	}
	return null;
}

/**
 * Core storage reaches module-owned objects (Drive files) only through these hooks, so it never reads a
 * module's tables. Null when no module declares the hook; a failing hook throws, so a migration retries.
 */
export async function callStorageHook<T>(
	objectClass: string,
	hook: StorageHookName,
	input: JsonValue,
): Promise<T | null> {
	const target = hookFor(objectClass, hook);
	if (!target) return null;
	const result = await invokeCapability(target.moduleId, target.name, input, SYSTEM_CONTEXT);
	if (!result.ok) throw new StorageHookError(`The ${objectClass} ${hook} hook failed: ${result.error.code}`);
	return result.output as T;
}
