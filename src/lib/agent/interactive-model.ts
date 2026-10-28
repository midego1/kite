import { getAutoReadInstallSettings } from "./auto-read/install-settings";
import { getAgentModel } from "./model";
import { getAgentEnabled, getAgentProviderConfig } from "./provider";

/** Why a request a person starts (the composer) may not run; each maps to its own answer. */
export type InteractiveRefusal =
	"assistant_disabled" | "not_configured" | "provider_key_unreadable" | "external_provider_not_allowed";

export class InteractiveModelRefusedError extends Error {
	constructor(readonly reason: InteractiveRefusal) {
		super(reason);
		this.name = "InteractiveModelRefusedError";
	}
}

/**
 * Whether interactive AI may run at all: the assistant is on and, for an external provider, the primary admin has
 * allowed it to read mail (the same switch as automatic reading). Workers AI needs no opt-in.
 */
export async function interactiveRefusal(env: CloudflareEnv): Promise<InteractiveRefusal | null> {
	if (!(await getAgentEnabled(env))) return "assistant_disabled";
	const config = await getAgentProviderConfig(env);
	if (config.keyUnreadable) return "provider_key_unreadable";
	if (config.provider === "compatible" && !(await getAutoReadInstallSettings(env)).externalAutoReadAllowed)
		return "external_provider_not_allowed";
	return null;
}

/**
 * The model for one composer request. The switch, the provider and the opt-in are read again on every request,
 * Try again included, so turning any of them off applies at once.
 */
export async function selectInteractiveModel(env: CloudflareEnv, modelId: string | null | undefined) {
	const refusal = await interactiveRefusal(env);
	if (refusal) throw new InteractiveModelRefusedError(refusal);
	const selection = await getAgentModel(env, modelId);
	if (!selection) throw new InteractiveModelRefusedError("not_configured");
	// The provider can change between the two reads; check the kind of the model actually chosen.
	if (selection.providerKind === "compatible" && !(await getAutoReadInstallSettings(env)).externalAutoReadAllowed)
		throw new InteractiveModelRefusedError("external_provider_not_allowed");
	return selection;
}
