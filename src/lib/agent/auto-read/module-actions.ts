import type { SessionUser } from "@/lib/auth/types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { buildCallContext } from "@/lib/modules/capability-utils";
import { findDescriptor } from "@/lib/modules/capability-registry";
import { invokeCapability, isModuleEnabled } from "@/lib/modules/invoke";
import type { CapabilityCallContext, JsonValue } from "@/lib/modules/module-types";
import { AgentActionError } from "./action-error";
import { moduleDisabledError } from "./action-response";
import type { ActionEffect, ActionState, AgentActionRow, ModuleActionViewer } from "./actions-types";
import { parseActionState } from "./actions-utils";
import { stepSkipReason } from "./module-steps-utils";
import type { ModuleActionOwner } from "./module-actions-utils";

type Refusal = { status: 403 | 409; error: string };

type ActionOutput = { result?: JsonValue; inverse?: JsonValue | null; refused?: Refusal };

function contextFor(viewer: ModuleActionViewer, owner: ModuleActionOwner, mailboxId: string): CapabilityCallContext {
	return buildCallContext({
		trigger: "api",
		viewer: { userId: viewer.userId, role: viewer.role, isPrimaryAdmin: viewer.isPrimaryAdmin },
		timeZone: viewer.timeZone,
		mailboxIds: [mailboxId],
		grants: findDescriptor(owner.moduleId, owner.capability)?.scopes ?? [],
	});
}

/** The skip reason recorded when the module owning an action is off for the viewer, or null. */
export async function moduleOffReason(viewer: ModuleActionViewer, owner: ModuleActionOwner): Promise<string | null> {
	const who = { userId: viewer.userId, role: viewer.role, isPrimaryAdmin: viewer.isPrimaryAdmin };
	return (await isModuleEnabled(who, owner.moduleId)) ? null : stepSkipReason(owner.moduleId);
}

async function call(
	owner: ModuleActionOwner,
	viewer: ModuleActionViewer,
	mailboxId: string,
	input: JsonValue,
): Promise<ActionOutput> {
	const result = await invokeCapability(owner.moduleId, owner.capability, input, contextFor(viewer, owner, mailboxId));
	if (!result.ok) {
		if (result.error.code === "module_disabled") throw moduleDisabledError(stepSkipReason(owner.moduleId));
		throw new Error(result.error.message);
	}
	return result.output as ActionOutput;
}

/**
 * Runs a module's action capability as the effect of an executor row. The row's id is the capability's
 * `actionId`, so a resumed pending row calls the handler again with the same id and the handler must
 * not repeat what it already did.
 */
export function moduleEffect(input: {
	owner: ModuleActionOwner;
	viewer: ModuleActionViewer;
	actionId: string;
	mailboxId: string;
	suggestion: { id: string | null; messageId: string | null; mailboxId: string };
	args: Record<string, JsonValue>;
}): ActionEffect {
	let inverse: JsonValue | null = null;
	return {
		async apply() {
			const output = await call(input.owner, input.viewer, input.mailboxId, {
				op: "execute",
				actionId: input.actionId,
				suggestion: input.suggestion,
				input: input.args,
			});
			if (output.refused) throw new Error(output.refused.error);
			inverse = output.inverse ?? null;
			const result = output.result;
			return result && typeof result === "object" && !Array.isArray(result) ? (result as ActionState) : {};
		},
		takeInverse: () => inverse,
	};
}

/**
 * What an undo hands back to the module: the inverse its handler stored, plus the original row's
 * outcome, so rows written before module actions existed (which keep their state in `before` and
 * `after`) can still be undone.
 */
function undoPayload(row: AgentActionRow): JsonValue {
	return {
		inverse: parseActionState(row.before) as JsonValue,
		result: parseActionState(row.after) as JsonValue,
		variant: row.variant,
		suggestionId: row.suggestionId,
		mailboxId: row.mailboxId,
		actingUserId: row.actingUserId,
	};
}

/**
 * Asks the owning module to take an action back, or with `authorizeOnly` only whether this user may,
 * before anything is claimed or changed. A refusal or failure becomes an `AgentActionError`.
 */
export async function undoModuleAction(
	owner: ModuleActionOwner,
	viewer: ModuleActionViewer,
	row: AgentActionRow,
	authorizeOnly = false,
): Promise<void> {
	const output = await call(owner, viewer, row.mailboxId, {
		op: authorizeOnly ? "authorize_undo" : "undo",
		actionId: row.id,
		inverse: undoPayload(row),
	});
	if (output.refused) throw new AgentActionError(output.refused.error, output.refused.status);
}

/**
 * Hands an accept click on a module's suggestion to the module's answering capability, as the
 * signed-in user. A module that is off refuses with `module_disabled` before anything runs.
 */
export async function answerSuggestion(
	owner: ModuleActionOwner,
	user: Pick<SessionUser, "id" | "role" | "isPrimaryAdmin" | "timeZone">,
	row: { id: string; mailboxId: string },
	option: string,
	deviceTimeZone: string | null,
): Promise<Record<string, unknown>> {
	const viewer = { userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin };
	const result = await invokeCapability(
		owner.moduleId,
		owner.capability,
		{ suggestionId: row.id, option, deviceTimeZone },
		buildCallContext({
			trigger: "api",
			viewer,
			timeZone: normalizeTimeZone(user.timeZone),
			mailboxIds: [row.mailboxId],
			grants: findDescriptor(owner.moduleId, owner.capability)?.scopes ?? [],
		}),
	);
	if (!result.ok) {
		if (result.error.code === "module_disabled") throw moduleDisabledError(stepSkipReason(owner.moduleId));
		throw new Error(result.error.message);
	}
	const output = result.output as {
		result?: Record<string, unknown> | null;
		refused?: { status: number; error: string };
	};
	if (output.refused) {
		const { status, error } = output.refused;
		throw new AgentActionError(error, status === 400 || status === 403 || status === 404 ? status : 409);
	}
	return output.result ?? {};
}
