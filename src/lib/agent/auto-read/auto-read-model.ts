import { InteractiveModelRefusedError } from "../interactive-model";
import { getAgentModel, type AgentModelRequest } from "../model";
import { externalProviderRefused } from "../external-provider";

export class ExternalProviderNotAllowedError extends Error {
	constructor() {
		super("The external AI provider is not allowed to read mail automatically");
		this.name = "ExternalProviderNotAllowedError";
	}
}

/**
 * The model for one automatic-reading request. The provider, the external opt-in and the mailbox's "No AI" switch
 * are read again for every request, because any of them can change while a job runs.
 */
export async function selectAutoReadModel(env: CloudflareEnv, request: AgentModelRequest) {
	const selection = await getAgentModel(env, request);
	if (!selection) throw new InteractiveModelRefusedError("not_configured");
	if (await externalProviderRefused(env, selection.providerKind)) throw new ExternalProviderNotAllowedError();
	return selection;
}
