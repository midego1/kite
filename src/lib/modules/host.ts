import type { ZodType } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { sendModuleMail } from "@/lib/email/module-send";
import { dispatchModuleWebhook } from "@/lib/email/module-webhooks";
import { findDescriptor, MODULE_CAPABILITIES } from "./capability-registry";
import type { HostResolvedRef, ModuleHost } from "./host-types";
import type { CapabilityCallContext, CapabilityResult, JsonValue, ModuleId } from "./module-types";
import { isModuleEnabledFor } from "./state";
import { createWebhookEmitter } from "./webhook-emit-utils";
import { WEBHOOK_EVENT_CATALOG, webhookEventOwner } from "./webhook-events-utils";

type Invoker = (
	moduleId: ModuleId,
	name: string,
	input: JsonValue,
	ctx: CapabilityCallContext,
) => Promise<CapabilityResult>;

let invoker: Invoker | null = null;

type PayloadSchemaReader = (moduleId: ModuleId, name: string) => ZodType | null;
type RefResolver = (ctx: CapabilityCallContext, refs: { kind: string; id: string }[]) => Promise<HostResolvedRef[]>;

let payloadSchemaReader: PayloadSchemaReader | null = null;
let refResolver: RefResolver | null = null;

/** `invoke.ts` binds itself here, so handlers can call other modules without importing `invoke.ts`. */
export function bindHostInvoker(next: Invoker, readPayloadSchema: PayloadSchemaReader): void {
	invoker = next;
	payloadSchemaReader = readPayloadSchema;
}

/** `record-refs.ts` binds itself here for the same reason: it imports `invoke.ts`, which imports this file. */
export function bindHostRefResolver(next: RefResolver): void {
	refResolver = next;
}

/**
 * A `service` capability is the surface one module offers another, so the caller holds the grants it
 * declares for the duration of the call; the caller's own grants are never reduced.
 */
function serviceContext(ctx: CapabilityCallContext, moduleId: ModuleId, name: string): CapabilityCallContext {
	const descriptor = findDescriptor(moduleId, name);
	if (!descriptor?.surfaces.includes("service")) return ctx;
	return {
		...ctx,
		grants: [...new Set([...(Array.isArray(ctx.grants) ? ctx.grants : []), ...(descriptor.scopes ?? [])])],
	};
}

/** The descriptor that declares `event` for the module; its input schema is the payload schema. */
function webhookDescriptorName(moduleId: ModuleId, event: string): string | undefined {
	return MODULE_CAPABILITIES.find((entry) => entry.moduleId === moduleId)?.descriptors.find(
		(descriptor) => descriptor.surfaces.includes("webhook_event") && descriptor.event?.value === event,
	)?.name;
}

const emitWebhook = createWebhookEmitter({
	owner: (event) => webhookEventOwner(WEBHOOK_EVENT_CATALOG, event),
	payloadSchema: async (moduleId, event) => {
		const name = webhookDescriptorName(moduleId, event);
		return name && payloadSchemaReader ? payloadSchemaReader(moduleId, name) : null;
	},
	isEnabledFor: (viewer, moduleId) => isModuleEnabledFor(getEnv(), viewer, moduleId),
	dispatch: (userId, event, payload) => dispatchModuleWebhook(getEnv(), userId, event, payload),
});

function pending(name: string) {
	return async (): Promise<never> => {
		throw new Error(`moduleHost.${name} is not implemented yet`);
	};
}

/** @public Consumed by tests and the features that wire modules into core surfaces. */
export const moduleHost: ModuleHost = {
	emitWebhook,
	invoke: async (ctx, moduleId, name, input) => {
		if (!invoker) throw new Error("moduleHost.invoke is not bound to invokeCapability");
		return invoker(moduleId, name, input, serviceContext(ctx, moduleId, name));
	},
	modules: { isEnabledFor: pending("modules.isEnabledFor") },
	resolveRefs: async (ctx, refs) => {
		if (!refResolver) throw new Error("moduleHost.resolveRefs is not bound to resolveRecordRefs");
		return refResolver(ctx, refs);
	},
	mail: {
		getMessage: pending("mail.getMessage"),
		readAttachment: pending("mail.readAttachment"),
		send: (ctx, draft) => sendModuleMail(getEnv(), ctx, draft),
		importMessages: pending("mail.importMessages"),
	},
	users: { getProfile: pending("users.getProfile") },
	audit: pending("audit"),
};
