import { InteractiveModelRefusedError } from "../interactive-model";
import { getAgentModel } from "../model";
import { getAutoReadInstallSettings } from "./install-settings";

export class ExternalProviderNotAllowedError extends Error {
	constructor() {
		super("The external AI provider is not allowed to read mail automatically");
		this.name = "ExternalProviderNotAllowedError";
	}
}

/**
 * The model for one automatic-reading request. The provider and the external opt-in are read
 * again for every request, because the primary admin can switch either while a job runs.
 */
export async function selectAutoReadModel(env: CloudflareEnv, modelId: string | null | undefined) {
	const selection = await getAgentModel(env, modelId);
	if (!selection) throw new InteractiveModelRefusedError("not_configured");
	if (selection.providerKind === "compatible" && !(await getAutoReadInstallSettings(env)).externalAutoReadAllowed)
		throw new ExternalProviderNotAllowedError();
	return selection;
}
