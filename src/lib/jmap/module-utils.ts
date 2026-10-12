import { selectCapabilities } from "@/lib/modules/capability-utils";
import type { CapabilityResult, JsonValue, ModuleCapabilities, ModuleId } from "@/lib/modules/module-types";
import type { JmapMethodError, JmapModuleSurface } from "./types";

/** The module part of a request when no module declares anything: the session and dispatch stay core-only. */
export const NO_JMAP_MODULES: JmapModuleSurface = {
	capabilities: {},
	methods: {},
	call: async () => ({ ok: false, error: { code: "unknown_capability", message: "Unknown capability" } }),
};

/**
 * The JMAP capabilities and methods the enabled modules declare, merged for one request.
 * `call` is how a method reaches its module (`invokeCapability` with the key's context).
 */
export function jmapModuleSurface(
	all: readonly ModuleCapabilities[],
	enabled: Iterable<ModuleId>,
	call: JmapModuleSurface["call"],
): JmapModuleSurface {
	const on = [...enabled];
	const capabilities: Record<string, JsonValue> = {};
	for (const { descriptor } of selectCapabilities(all, "jmap_capability", on)) {
		const urn = descriptor.jmap?.urn;
		if (urn && !Object.hasOwn(capabilities, urn)) capabilities[urn] = descriptor.jmap?.capability ?? {};
	}
	const methods: JmapModuleSurface["methods"] = {};
	for (const { moduleId, descriptor } of selectCapabilities(all, "jmap_method", on)) {
		const method = descriptor.jmap?.method;
		if (method && !Object.hasOwn(methods, method)) methods[method] = { moduleId, name: descriptor.name };
	}
	return { capabilities, methods, call };
}

/** A module method's result as a JMAP method response: its output, or a method error that reveals no handler detail. */
export function moduleMethodResult(result: CapabilityResult): Record<string, unknown> | JmapMethodError {
	if (result.ok) {
		const output = result.output;
		return output !== null && typeof output === "object" && !Array.isArray(output) ? output : { value: output };
	}
	switch (result.error.code) {
		case "module_disabled":
		case "unknown_capability":
			return { type: "unknownMethod" };
		case "forbidden":
			return { type: "forbidden" };
		case "invalid_input":
			return { type: "invalidArguments", description: result.error.message };
		default:
			return { type: "serverFail" };
	}
}
