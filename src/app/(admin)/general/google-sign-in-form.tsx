"use client";

import type { GoogleClientStatus } from "@/lib/external-accounts/types";
import { OAuthClientForm, type OAuthClientFormConfig } from "./oauth-client-form";

function statusText(status: GoogleClientStatus): string {
	if (status.migrationPending) return "Apply the pending database update to set up Google sign-in.";
	const domain = status.hostedDomain ? `, Workspace domain ${status.hostedDomain} only` : ", any Google account";
	if (status.source === "env" && !status.clientId)
		return "Off: the GOOGLE_OAUTH_* variables are set but not valid. Check the Client ID and the Workspace domain.";
	if (status.source === "env") return `On, from the GOOGLE_OAUTH_* variables: client ${status.clientId}${domain}.`;
	if (status.source === "settings") return `On: client ${status.clientId}${domain}.`;
	if (status.unreadable)
		return "The saved client cannot be read because APP_ENCRYPTION_KEY is missing or has changed. Save it again.";
	return "Off. Gmail and Google Workspace accounts connect with an app password.";
}

const CONFIG: OAuthClientFormConfig<GoogleClientStatus> = {
	provider: "google",
	title: "Google sign-in",
	intro:
		"Lets users connect Gmail and Google Workspace accounts by signing in with Google instead of an app password. Create an OAuth client (type Web application) in Google Cloud with this redirect URI, then enter its Client ID and secret here.",
	statusText,
	redirect: {
		id: "google-redirect-uri",
		label: "Authorized redirect URI",
		appUrlHint:
			"APP_URL is not set, so this is the address you opened Kite at. Set APP_URL to the public HTTPS address first; Google only accepts http for localhost.",
	},
	clientId: {
		id: "google-client-id",
		label: "Client ID",
		placeholder: (status) => status.clientId ?? "123456789012-abc.apps.googleusercontent.com",
	},
	extra: {
		key: "hostedDomain",
		id: "google-hosted-domain",
		label: "Workspace domain (optional)",
		placeholder: (status) => status.hostedDomain ?? "Any Google account",
	},
	secret: {
		id: "google-client-secret",
		label: "Client secret",
		help: "Workspace domain: only accounts of that Google Workspace domain can sign in. Leave it empty to allow Gmail and any Workspace.",
	},
	saved: "Saved. Users can now connect Google accounts with Sign in with Google.",
	remove: {
		title: "Remove Google sign-in?",
		description:
			"Gmail and Workspace accounts connected with Google sign-in stop syncing and sending when their current access runs out, until you save a client again. Accounts with an app password are not affected.",
		done: "Google sign-in removed.",
	},
};

/**
 * **Google sign-in** (spec §15.7): the owner's own Google Cloud OAuth client, so users can connect Gmail and Google
 * Workspace accounts without an app password. The client secret is checked with Google, saved sealed and never shown
 * again. Steps are in docs/providers.md.
 */
export function GoogleSignInForm() {
	return <OAuthClientForm config={CONFIG} />;
}
