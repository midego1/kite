import type { LifecycleEmitterDeps, LifecycleEvent, LifecycleEventType, LifecycleTarget } from "./lifecycle-types";
import type { CapabilityCallContext, JsonValue } from "./module-types";

/**
 * Every lifecycle descriptor that declares `type`, whatever its module's state: the invoker decides who may run.
 * @public Test-only: used inside this file, exported for tests.
 */
export function lifecycleTargets(
	capabilities: LifecycleEmitterDeps["capabilities"],
	type: LifecycleEventType,
): LifecycleTarget[] {
	return capabilities.flatMap((entry) =>
		entry.descriptors
			.filter((descriptor) => descriptor.surfaces.includes("lifecycle") && descriptor.lifecycle?.event === type)
			.map((descriptor) => ({ moduleId: entry.moduleId, descriptor })),
	);
}

/** A lifecycle event has no viewer and no session; the hooks act on the user the event names. */
const SYSTEM_CONTEXT: CapabilityCallContext = {
	viewer: null,
	requestId: "lifecycle",
	locale: "en",
	timeZone: "UTC",
	grants: [],
	trigger: "system",
};

/**
 * Builds the function core calls after it has written a user or changed a time zone. Each matching hook
 * runs through the invoker, which skips a disabled module's hook unless it is a data hook. A hook that
 * fails, refuses or throws is logged and never reaches the caller, so the core write stands.
 */
export function createLifecycleEmitter(deps: LifecycleEmitterDeps) {
	return async function emitLifecycleEvent(event: LifecycleEvent): Promise<void> {
		for (const { moduleId, descriptor } of lifecycleTargets(deps.capabilities, event.type)) {
			try {
				const ctx = { ...SYSTEM_CONTEXT, requestId: crypto.randomUUID() };
				const result = await deps.invoke(moduleId, descriptor.name, event as unknown as JsonValue, ctx);
				if (!result.ok && result.error.code !== "module_disabled")
					deps.log("lifecycle.hook_failed", {
						moduleId,
						capability: descriptor.name,
						event: event.type,
						code: result.error.code,
					});
			} catch (error) {
				deps.log("lifecycle.hook_failed", {
					moduleId,
					capability: descriptor.name,
					event: event.type,
					code: "handler_error",
					error,
				});
			}
		}
	};
}
