import { externalProviderRefused } from "./external-provider";
import { mailboxAiOff } from "./mailbox-ai";
import { MailboxAiOffError } from "./mailbox-ai-utils";
import { getAgentModel, type AgentModelRequest } from "./model";
import { getAgentEnabled, getAgentProviderConfig } from "./provider";

/** Why a request a person starts (chat, the composer, summaries) may not run; each maps to its own answer. */
export type InteractiveRefusal =
	| "assistant_disabled"
	| "not_configured"
	| "provider_key_unreadable"
	| "external_provider_not_allowed"
	| "mailbox_ai_off";

export class InteractiveModelRefusedError extends Error {
	constructor(readonly reason: InteractiveRefusal) {
		super(reason);
		this.name = "InteractiveModelRefusedError";
	}
}

/**
 * Whether interactive AI may run at all: the assistant is on and, for an external provider, the primary admin has
 * allowed it to read mail (the same switch as automatic reading). Workers AI needs no opt-in. With a mailbox, also
 * whether AI is on for it ("No AI for this mailbox").
 */
export async function interactiveRefusal(env: CloudflareEnv, mailboxId?: string): Promise<InteractiveRefusal | null> {
	if (!(await getAgentEnabled(env))) return "assistant_disabled";
	if (mailboxId && (await mailboxAiOff(env, mailboxId))) return "mailbox_ai_off";
	const config = await getAgentProviderConfig(env);
	if (config.keyUnreadable) return "provider_key_unreadable";
	if (await externalProviderRefused(env, config.provider)) return "external_provider_not_allowed";
	return null;
}

/**
 * The model for one chat turn, composer or summary request. The switch, the provider and the opt-in are read again
 * on every request, Try again included, so turning any of them off applies at once.
 */
export async function selectInteractiveModel(env: CloudflareEnv, request: AgentModelRequest) {
	const refusal = await interactiveRefusal(env, request.mailboxId);
	if (refusal) throw new InteractiveModelRefusedError(refusal);
	const selection = await getAgentModel(env, request).catch((error: unknown) => {
		throw error instanceof MailboxAiOffError ? new InteractiveModelRefusedError("mailbox_ai_off") : error;
	});
	if (!selection) throw new InteractiveModelRefusedError("not_configured");
	// The provider can change between the two reads; check the kind of the model actually chosen.
	if (await externalProviderRefused(env, selection.providerKind))
		throw new InteractiveModelRefusedError("external_provider_not_allowed");
	return selection;
}
