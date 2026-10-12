import type { z } from "zod";
import { jsonValueProblem } from "./json-utils";
import type { CapabilityCallContext, JsonValue, ModuleId } from "./module-types";

export type WebhookEmitDeps = {
	/** The module that declares the event: `null` for a core event, `undefined` for an unknown one. */
	owner(event: string): ModuleId | null | undefined;
	/** The schema a module's payload for the event must satisfy, or `null` when the module declares none. */
	payloadSchema(moduleId: ModuleId, event: string): Promise<z.ZodType | null>;
	isEnabledFor(viewer: NonNullable<CapabilityCallContext["viewer"]>, moduleId: ModuleId): Promise<boolean>;
	dispatch(userId: string, event: string, payload: Record<string, unknown>): Promise<void>;
};

/** A module asked to emit something it may not: another module's event or a payload that breaks the event's schema. @public Consumed by tests. */
export class WebhookEmitError extends Error {}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `ModuleHost.emitWebhook`: a module may emit only the events it declares, with a payload that satisfies the
 * event's schema. Refusals throw. An event of a module that is off for the acting user is dropped silently,
 * because the module may still be mid-request when an admin turns it off.
 */
export function createWebhookEmitter(deps: WebhookEmitDeps) {
	return async function emitWebhook(
		ctx: CapabilityCallContext,
		moduleId: ModuleId,
		event: string,
		payload: JsonValue,
	): Promise<void> {
		const owner = deps.owner(event);
		if (owner === undefined) throw new WebhookEmitError(`Unknown webhook event ${event}`);
		if (owner !== moduleId) throw new WebhookEmitError(`Webhook event ${event} does not belong to module ${moduleId}`);
		const schema = await deps.payloadSchema(moduleId, event);
		if (!schema) throw new WebhookEmitError(`Webhook event ${event} has no payload schema`);
		const problem = jsonValueProblem(payload, "payload");
		if (problem) throw new WebhookEmitError(problem);
		const parsed = schema.safeParse(payload);
		if (!parsed.success || !isRecord(payload)) {
			const issue = parsed.success ? null : parsed.error.issues[0];
			throw new WebhookEmitError(
				`Invalid payload for ${event}${issue ? `: ${issue.path.map(String).join(".") || "payload"}: ${issue.message}` : ""}`,
			);
		}
		if (!ctx.viewer) throw new WebhookEmitError("A webhook event needs an acting user");
		if (!(await deps.isEnabledFor(ctx.viewer, moduleId))) return;
		await deps.dispatch(ctx.viewer.userId, event, payload);
	};
}
