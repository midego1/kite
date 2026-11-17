"use client";

import type { MicrosoftClientStatus } from "@/lib/external-accounts/types";
import { OAuthClientForm, type OAuthClientFormConfig } from "./oauth-client-form";

function statusText(status: MicrosoftClientStatus): string {
	if (status.migrationPending) return "Apply the pending database update to set up Microsoft sign-in.";
	if (status.source === "env")
		return `On, from the MICROSOFT_OAUTH_* variables: application ${status.clientId}, tenant ${status.tenant}.`;
	if (status.source === "settings") return `On: application ${status.clientId}, tenant ${status.tenant}.`;
	if (status.unreadable)
		return "The saved registration cannot be read because APP_ENCRYPTION_KEY is missing or has changed. Save it again.";
	return "Off. Outlook.com and Microsoft 365 accounts can only forward their mail to Kite.";
}

const CONFIG: OAuthClientFormConfig<MicrosoftClientStatus> = {
	provider: "microsoft",
	title: "Microsoft sign-in",
	intro:
		"Lets users connect Outlook.com, Hotmail and Microsoft 365 accounts, which only sign in with Microsoft. Register an app in Microsoft Entra with this redirect URI, then enter its IDs and a client secret here.",
	statusText,
	redirect: {
		id: "microsoft-redirect-uri",
		label: "Redirect URI (Web)",
		appUrlHint:
			"APP_URL is not set, so this is the address you opened Kite at. Set APP_URL to the public HTTPS address first; Microsoft only accepts http for localhost.",
	},
	clientId: {
		id: "microsoft-client-id",
		label: "Application (client) ID",
		placeholder: (status) => status.clientId ?? "00000000-0000-0000-0000-000000000000",
	},
	extra: { key: "tenant", id: "microsoft-tenant", label: "Tenant", placeholder: (status) => status.tenant ?? "common" },
	secret: {
		id: "microsoft-client-secret",
		label: "Client secret (Value)",
		help: "Tenant: common for work, school and personal accounts; your tenant ID for one organisation only.",
	},
	saved: "Saved. Users can now connect Microsoft accounts.",
	remove: {
		title: "Remove Microsoft sign-in?",
		description:
			"Connected Microsoft accounts stop syncing and sending when their current access runs out, and new ones cannot be connected until you save a registration again.",
		done: "Microsoft sign-in removed.",
	},
};

/**
 * **Microsoft sign-in** (spec §15.1): the owner's own Microsoft Entra app registration, so users can connect
 * Outlook.com and Microsoft 365 accounts. The client secret is checked with Microsoft, saved sealed and never shown
 * again. Steps are in docs/providers.md.
 */
export function MicrosoftSignInForm() {
	return <OAuthClientForm config={CONFIG} />;
}
