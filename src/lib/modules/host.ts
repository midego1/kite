import type { ZodType } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { importModuleMessages } from "@/lib/email/module-import";
import { getModuleMessage, readModuleAttachment } from "@/lib/email/module-read";
import { recentModuleMessagesFromSender } from "@/lib/email/module-recent";
import { sendModuleMail } from "@/lib/email/module-send";
import { dispatchModuleWebhook } from "@/lib/email/module-webhooks";
import { findDescriptor, MODULE_CAPABILITIES } from "./capability-registry";
import type { HostAgentServices, HostResolvedRef, ModuleHost } from "./host-types";
import {
	findViewerContact,
	getUserProfile,
	isModuleEnabledForUser,
	notifyModuleUsers,
	recordModuleAudit,
} from "./host-services";
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

let agentServices: HostAgentServices | null = null;

/** Automatic reading binds its suggestion and action services here; it imports `invoke.ts` as well. */
export function bindHostAgentServices(next: HostAgentServices): void {
	agentServices = next;
}

function boundAgentServices(): HostAgentServices {
	if (!agentServices) throw new Error("moduleHost.suggestions and actions are not bound to automatic reading");
	return agentServices;
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

/** The only door from module code into core services. */
export const moduleHost: ModuleHost = {
	emitWebhook,
	invoke: async (ctx, moduleId, name, input) => {
		if (!invoker) throw new Error("moduleHost.invoke is not bound to invokeCapability");
		return invoker(moduleId, name, input, serviceContext(ctx, moduleId, name));
	},
	modules: { isEnabledFor: (_ctx, userId, moduleId) => isModuleEnabledForUser(getEnv(), userId, moduleId) },
	resolveRefs: async (ctx, refs) => {
		if (!refResolver) throw new Error("moduleHost.resolveRefs is not bound to resolveRecordRefs");
		return refResolver(ctx, refs);
	},
	suggestions: {
		get: (ctx, moduleId, suggestionId) => boundAgentServices().getSuggestion(ctx, moduleId, suggestionId),
		decide: (ctx, moduleId, suggestionId, status) =>
			boundAgentServices().decideSuggestion(ctx, moduleId, suggestionId, status),
	},
	actions: { execute: (ctx, moduleId, call) => boundAgentServices().executeAction(ctx, moduleId, call) },
	notify: (_ctx, moduleId, userIds, notice) => notifyModuleUsers(getEnv(), moduleId, userIds, notice),
	contacts: { find: (ctx, userId, email) => findViewerContact(getEnv(), ctx, userId, email) },
	mail: {
		getMessage: (ctx, messageId, options) => getModuleMessage(getEnv(), ctx, messageId, options),
		recentFromSender: (ctx, query) => recentModuleMessagesFromSender(getEnv(), ctx, query),
		readAttachment: (ctx, messageId, attachmentId, options) =>
			readModuleAttachment(getEnv(), ctx, messageId, attachmentId, options),
		send: (ctx, draft) => sendModuleMail(getEnv(), ctx, draft),
		importMessages: (_ctx, request) => importModuleMessages(getEnv(), request),
	},
	users: { getProfile: (_ctx, userId) => getUserProfile(getEnv(), userId) },
	audit: (ctx, action, metadata) => recordModuleAudit(getEnv(), ctx, action, metadata),
};
