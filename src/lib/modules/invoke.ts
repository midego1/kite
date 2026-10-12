import { getEnv } from "@/lib/cloudflare";
import { createLogger } from "@/lib/logger.mjs";
import { findDescriptor } from "./capability-registry";
import { bindHostInvoker } from "./host";
import { createInvoker, type InvokeEntry } from "./invoke-utils";
import type { CapabilityCallContext, ModuleId } from "./module-types";
// Loaded for its side effect: it binds `moduleHost.resolveRefs`, and only uses `invokeCapability` when called.
import "./record-refs";
import { SERVER_MODULES } from "./server-registry";
import { isModuleEnabled as isInstallModuleEnabled, isModuleEnabledFor } from "./state";

const log = createLogger("modules");

/** Answers whether a module is on for the viewer (the install when `viewer` is null). */
type ModuleStateReader = (viewer: CapabilityCallContext["viewer"], moduleId: ModuleId) => Promise<boolean>;

const readStoredModuleState: ModuleStateReader = (viewer, moduleId) =>
	viewer ? isModuleEnabledFor(getEnv(), viewer, moduleId) : isInstallModuleEnabled(getEnv(), moduleId);

let stateReader: ModuleStateReader = readStoredModuleState;

/**
 * Replaces the stored module state, or restores it with `null`.
 * @public Consumed by tests that run capabilities without a database.
 */
export function setModuleStateReader(reader: ModuleStateReader | null): void {
	stateReader = reader ?? readStoredModuleState;
}

export async function isModuleEnabled(viewer: CapabilityCallContext["viewer"], moduleId: ModuleId): Promise<boolean> {
	return stateReader(viewer, moduleId);
}

function lookup(moduleId: ModuleId, name: string): InvokeEntry | null {
	const descriptor = findDescriptor(moduleId, name);
	const server = SERVER_MODULES[moduleId];
	const handler = server?.handlers[name];
	const schemas = server?.schemas[name];
	if (!descriptor || !handler || !schemas) return null;
	return { descriptor, handler, inputSchema: schemas.input, outputSchema: schemas.output };
}

/** The input schema a capability validates against, for core that must check a payload a module will receive. */
export function capabilityInputSchema(moduleId: ModuleId, name: string) {
	return SERVER_MODULES[moduleId]?.schemas[name]?.input ?? null;
}

/** The only path from core into module code. */
export const invokeCapability = createInvoker({
	lookup,
	isEnabled: isModuleEnabled,
	log: ({ code, error, ...fields }) => {
		if (code === "ok") log.debug("capability.invoke", { ...fields, code });
		else log.warn("capability.invoke", error === undefined ? { ...fields, code } : { ...fields, code, error });
	},
});

bindHostInvoker(invokeCapability, capabilityInputSchema);
