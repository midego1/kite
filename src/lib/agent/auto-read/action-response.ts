import { AgentActionError } from "./action-error";
import type { ExecuteActionResult } from "./actions-types";

/** Runs a suggestion or action call and answers with its result, or with the status of a refusal. */
export async function agentActionResponse(run: () => Promise<unknown>): Promise<Response> {
	try {
		return Response.json(await run());
	} catch (caught) {
		if (caught instanceof AgentActionError) return Response.json({ error: caught.message }, { status: caught.status });
		throw caught;
	}
}

/** An executor result that ran (or already ran), or the refusal as a 409 carrying its reason. */
export function settled(result: ExecuteActionResult): ExecuteActionResult {
	if (result.status === "applied" || result.status === "skipped") return result;
	throw new AgentActionError(result.reason ?? "The action could not be completed", 409);
}
