import { MODULE_MANIFESTS } from "@/lib/modules/registry";
import { AgentActionError } from "./action-error";
import type { ExecuteActionResult } from "./actions-types";

/** Runs a suggestion or action call and answers with its result, or with the status of a refusal. */
export async function agentActionResponse(run: () => Promise<unknown>): Promise<Response> {
	try {
		return Response.json(await run());
	} catch (caught) {
		if (caught instanceof AgentActionError)
			return Response.json(
				{ error: caught.message, ...(caught.code ? { code: caught.code } : {}) },
				{ status: caught.status },
			);
		throw caught;
	}
}

const MODULE_DISABLED = "module_disabled";

/** The refusal for a module that is off, in the module's own words from its manifest. */
export function moduleDisabledError(reason: string): AgentActionError {
	const text = MODULE_MANIFESTS.map((manifest) => manifest.reasonTexts[reason]).find(Boolean);
	return new AgentActionError(text ?? "This module is turned off", 409, MODULE_DISABLED);
}

/** An executor result that ran (or already ran), or the refusal as a 409 carrying its reason. */
export function settled(result: ExecuteActionResult): ExecuteActionResult {
	if (result.status === "applied" || result.status === "skipped") return result;
	if (result.reason?.startsWith(MODULE_DISABLED)) throw moduleDisabledError(result.reason);
	throw new AgentActionError(result.reason ?? "The action could not be completed", 409);
}
