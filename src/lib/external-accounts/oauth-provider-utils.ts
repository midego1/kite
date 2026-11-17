import { GOOGLE_IMAP, GOOGLE_SMTP } from "./oauth-google-utils";
import { MICROSOFT_IMAP, MICROSOFT_SMTP } from "./oauth-utils";
import { addressDomain, findPreset } from "./presets-utils";
import type { ExternalAccountAuthKind, ExternalAccountPresetId, MailServerSettings } from "./types";

/** The providers a connected account can sign in with instead of a password (spec §15). */
export type OAuthProviderId = "microsoft" | "google";

export type OAuthProviderInfo = {
	id: OAuthProviderId;
	/** The provider's name in messages: "Microsoft sign-in expired", "Sign in with Google". */
	label: string;
	authKind: Exclude<ExternalAccountAuthKind, "password">;
	/** The presets whose accounts may sign in with it. */
	presets: readonly ExternalAccountPresetId[];
	imap: MailServerSettings;
	smtp: MailServerSettings;
};

/** What differs between the providers outside their endpoints and tokens. */
export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderInfo> = {
	microsoft: {
		id: "microsoft",
		label: "Microsoft",
		authKind: "oauth_microsoft",
		presets: ["microsoft"],
		imap: MICROSOFT_IMAP,
		smtp: MICROSOFT_SMTP,
	},
	google: {
		id: "google",
		label: "Google",
		authKind: "oauth_google",
		presets: ["gmail", "google_workspace"],
		imap: GOOGLE_IMAP,
		smtp: GOOGLE_SMTP,
	},
};

export function isOAuthProvider(value: unknown): value is OAuthProviderId {
	return value === "microsoft" || value === "google";
}

/** The provider an account signs in with (its `auth_kind`), or null for a password account. */
export function oauthProviderOf(authKind: string): OAuthProviderId | null {
	if (authKind === "oauth_microsoft") return "microsoft";
	if (authKind === "oauth_google") return "google";
	return null;
}

/** The preset of an account connected with a provider: Microsoft's own; Gmail for a Gmail address, else Workspace. */
export function oauthAccountPreset(provider: OAuthProviderId, address: string): ExternalAccountPresetId {
	if (provider === "microsoft") return "microsoft";
	return findPreset("gmail")!.domains.includes(addressDomain(address) ?? "") ? "gmail" : "google_workspace";
}
