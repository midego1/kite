import type { ModuleHost } from "./host-types";
import type { CapabilityCallContext, CapabilityResult, JsonValue, ModuleId } from "./module-types";

type Invoker = (
	moduleId: ModuleId,
	name: string,
	input: JsonValue,
	ctx: CapabilityCallContext,
) => Promise<CapabilityResult>;

let invoker: Invoker | null = null;

/** `invoke.ts` binds itself here, so handlers can call other modules without importing `invoke.ts`. */
export function bindHostInvoker(next: Invoker): void {
	invoker = next;
}

function pending(name: string) {
	return async (): Promise<never> => {
		throw new Error(`moduleHost.${name} is not implemented yet`);
	};
}

/** @public Consumed by tests and the features that wire modules into core surfaces. */
export const moduleHost: ModuleHost = {
	emitWebhook: pending("emitWebhook"),
	invoke: async (ctx, moduleId, name, input) => {
		if (!invoker) throw new Error("moduleHost.invoke is not bound to invokeCapability");
		return invoker(moduleId, name, input, ctx);
	},
	modules: { isEnabledFor: pending("modules.isEnabledFor") },
	resolveRefs: pending("resolveRefs"),
	mail: {
		getMessage: pending("mail.getMessage"),
		readAttachment: pending("mail.readAttachment"),
		send: pending("mail.send"),
		importMessages: pending("mail.importMessages"),
	},
	users: { getProfile: pending("users.getProfile") },
	audit: pending("audit"),
};
