import { createLogger } from "@/lib/logger.mjs";
import { findDescriptor } from "./capability-registry";
import { bindHostInvoker } from "./host";
import { createInvoker, type InvokeEntry } from "./invoke-utils";
import type { CapabilityCallContext, ModuleId } from "./module-types";
import { isEnabledByDefault } from "./registry";
import { SERVER_MODULES } from "./server-registry";

const log = createLogger("modules");

/** Answers whether a module is on for the viewer (the install when `viewer` is null). */
type ModuleStateReader = (viewer: CapabilityCallContext["viewer"], moduleId: ModuleId) => Promise<boolean>;

let stateReader: ModuleStateReader | null = null;

/**
 * Without a reader every module follows its manifest default, which is how a database without module settings behaves.
 * @public Consumed by tests and the features that wire modules into core surfaces.
 */
export function setModuleStateReader(reader: ModuleStateReader | null): void {
	stateReader = reader;
}

export async function isModuleEnabled(viewer: CapabilityCallContext["viewer"], moduleId: ModuleId): Promise<boolean> {
	return stateReader ? stateReader(viewer, moduleId) : isEnabledByDefault(moduleId);
}

function lookup(moduleId: ModuleId, name: string): InvokeEntry | null {
	const descriptor = findDescriptor(moduleId, name);
	const server = SERVER_MODULES[moduleId];
	const handler = server?.handlers[name];
	const schemas = server?.schemas[name];
	if (!descriptor || !handler || !schemas) return null;
	return { descriptor, handler, inputSchema: schemas.input, outputSchema: schemas.output };
}

/**
 * The only path from core into module code.
 * @public Consumed by tests and the features that wire modules into core surfaces.
 */
export const invokeCapability = createInvoker({
	lookup,
	isEnabled: isModuleEnabled,
	log: ({ code, error, ...fields }) => {
		if (code === "ok") log.debug("capability.invoke", { ...fields, code });
		else log.warn("capability.invoke", error === undefined ? { ...fields, code } : { ...fields, code, error });
	},
});

bindHostInvoker(invokeCapability);
