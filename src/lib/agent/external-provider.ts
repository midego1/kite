import { getAutoReadInstallSettings } from "./auto-read/install-settings";

/**
 * The one rule for the primary admin's external-provider opt-in: a model at an external provider (anything but
 * Workers AI) may be sent mail content only while the opt-in is on. Every entry point that sends mail content to a
 * model asks before each model request, because the opt-in can be turned off at any time: chat (every step), Write
 * with Kite, summaries, automatic reading with its reply drafts, one-line summaries and the legacy auto-draft.
 */
export async function externalProviderRefused(env: CloudflareEnv, providerKind: "cloudflare" | "compatible") {
	return providerKind === "compatible" && !(await getAutoReadInstallSettings(env)).externalAutoReadAllowed;
}
