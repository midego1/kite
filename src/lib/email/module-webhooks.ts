import { dispatchWebhooks } from "@/lib/email/webhooks";

/** The core end of `ModuleHost.emitWebhook`: modules never import the dispatcher, the host reaches it here. */
export function dispatchModuleWebhook(
	env: CloudflareEnv,
	userId: string,
	event: string,
	payload: Record<string, unknown>,
): Promise<void> {
	return dispatchWebhooks(env, userId, event, payload);
}
