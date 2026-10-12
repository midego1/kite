import { getAgentModel } from "../model";
import { modelTrainsOnData } from "../model-training-utils";
import { getAutoReadInstallSettings } from "./install-settings";

export class ExternalProviderNotAllowedError extends Error {
	constructor() {
		super("The external AI provider is not allowed to read mail automatically");
		this.name = "ExternalProviderNotAllowedError";
	}
}

export class TrainingModelNotAllowedError extends Error {
	constructor() {
		super("The model may train on the mail sent to it, so automatic reading will not use it");
		this.name = "TrainingModelNotAllowedError";
	}
}

/**
 * The model for one automatic-reading request. The provider and the external opt-in are read
 * again for every request, because the primary admin can switch either while a job runs.
 */
export async function selectAutoReadModel(env: CloudflareEnv, modelId: string | null | undefined) {
	const selection = await getAgentModel(env, modelId);
	if (!selection) throw new Error("AI provider is not configured");
	if (selection.providerKind === "compatible" && !(await getAutoReadInstallSettings(env)).externalAutoReadAllowed)
		throw new ExternalProviderNotAllowedError();
	if (modelTrainsOnData(selection.modelId)) throw new TrainingModelNotAllowedError();
	return selection;
}
