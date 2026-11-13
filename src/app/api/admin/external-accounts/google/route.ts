import { oauthClientRoutes } from "@/lib/external-accounts/oauth-client-routes";
import {
	clearGoogleClient,
	googleClientFromEnv,
	googleClientStatus,
	saveGoogleClient,
	validateGoogleClient,
} from "@/lib/external-accounts/oauth-google-client";
import { parseGoogleClientInput } from "@/lib/external-accounts/oauth-google-utils";

const routes = oauthClientRoutes({
	provider: "google",
	envWins:
		"Google sign-in is set with the GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET variables, which take precedence. Remove them to manage it here.",
	pending: "Apply the pending database update before setting up Google sign-in.",
	unverified:
		"Google could not be reached, so the client was saved without a check. Connecting an account will show whether it works.",
	fromEnv: googleClientFromEnv,
	status: googleClientStatus,
	parse: parseGoogleClientInput,
	validate: (env, client, redirectUri) => validateGoogleClient(env, client, redirectUri),
	save: saveGoogleClient,
	clear: clearGoogleClient,
	auditDetails: (client) => ({ clientId: client.clientId, hostedDomain: client.hostedDomain }),
});

/** Where Google sign-in stands (Admin → General): the client ID, Workspace domain and redirect URI, never the secret. */
export async function GET(request: Request) {
	return routes.GET(request);
}

/** Checks the OAuth client with Google, then saves it sealed with APP_ENCRYPTION_KEY. The secret is never sent back. */
export async function PUT(request: Request) {
	return routes.PUT(request);
}

/** Removes the saved OAuth client; Google accounts stop renewing their access until one is saved again. */
export async function DELETE(request: Request) {
	return routes.DELETE(request);
}
