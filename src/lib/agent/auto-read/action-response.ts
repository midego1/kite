import { AgentActionError } from "./action-error";

/** Runs a suggestion or action call and answers with its result, or with the status of a refusal. */
export async function agentActionResponse(run: () => Promise<unknown>): Promise<Response> {
	try {
		return Response.json(await run());
	} catch (caught) {
		if (caught instanceof AgentActionError) return Response.json({ error: caught.message }, { status: caught.status });
		throw caught;
	}
}
