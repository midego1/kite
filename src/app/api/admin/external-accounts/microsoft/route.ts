import {
	clearMicrosoftClient,
	microsoftClientStatus,
	saveMicrosoftClient,
	validateMicrosoftClient,
} from "@/lib/external-accounts/oauth-client";
import { oauthClientRoutes } from "@/lib/external-accounts/oauth-client-routes";
import { parseMicrosoftClientInput } from "@/lib/external-accounts/oauth-utils";

const routes = oauthClientRoutes({
	provider: "microsoft",
	envWins:
		"Microsoft sign-in is set with the MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET variables, which take precedence. Remove them to manage it here.",
	pending: "Apply the pending database update before setting up Microsoft sign-in.",
	unverified:
		"Microsoft could not be reached, so the registration was saved without a check. Connecting an account will show whether it works.",
	fromEnv: (env) => !!(env.MICROSOFT_OAUTH_CLIENT_ID?.trim() && env.MICROSOFT_OAUTH_CLIENT_SECRET?.trim()),
	status: microsoftClientStatus,
	parse: parseMicrosoftClientInput,
	validate: (env, client, redirectUri) => validateMicrosoftClient(env, client, redirectUri),
	save: saveMicrosoftClient,
	clear: clearMicrosoftClient,
	auditDetails: (client) => ({ clientId: client.clientId, tenant: client.tenant }),
});

/** Where Microsoft sign-in stands (Admin → General): the client ID, tenant and redirect URI, never the secret. */
export async function GET(request: Request) {
	return routes.GET(request);
}

/** Checks the registration with Microsoft, then saves it sealed with APP_ENCRYPTION_KEY. The secret is never sent back. */
export async function PUT(request: Request) {
	return routes.PUT(request);
}

export async function DELETE(request: Request) {
	return routes.DELETE(request);
}
