/**
 * A secret only this install knows, for keyed hashes and MACs that must not be recomputable from the database alone:
 * APP_ENCRYPTION_KEY, else INBOUND_WEBHOOK_SECRET, else CF_TOKEN; null when none is set.
 */
export function serverSecret(env: Pick<CloudflareEnv, "APP_ENCRYPTION_KEY" | "INBOUND_WEBHOOK_SECRET" | "CF_TOKEN">) {
	for (const value of [env.APP_ENCRYPTION_KEY, env.INBOUND_WEBHOOK_SECRET, env.CF_TOKEN]) {
		const secret = value?.trim();
		if (secret) return secret;
	}
	return null;
}
