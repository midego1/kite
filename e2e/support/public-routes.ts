/**
 * API routes that answer an anonymous caller on purpose. Every other route under `src/app/api` must
 * answer 401 or 403 without a session. The status is exact: a change here is a change in what an
 * unauthenticated visitor can reach.
 */
export type PublicRoute = { method: string; path: string; status: number; reason: string };

/** Routes the security spec never calls, with the reason. */
export const SKIPPED_ROUTES: { method: string; path: string; reason: string }[] = [
	{
		method: "POST",
		path: "/api/seed",
		reason: "Reseeds the database in development (403 in production); probing it would wipe the suite's data",
	},
];

export const PUBLIC_ROUTES: PublicRoute[] = [
	{
		method: "GET",
		path: "/api/auth/accounts",
		status: 200,
		reason: "Sign-in screen account chooser; returns [] without the accounts cookie",
	},
	{ method: "GET", path: "/api/branding", status: 200, reason: "Login page renders the instance name and colours" },
	{
		method: "GET",
		path: "/api/branding/icon",
		status: 200,
		reason: "Public icon used by the login page and the web manifest",
	},
	{
		method: "GET",
		path: "/api/setup/status",
		status: 200,
		reason: "Setup wizard checks whether the instance is initialised",
	},
	{ method: "POST", path: "/api/auth/logout", status: 200, reason: "Clearing a missing session is a no-op" },
	{
		method: "POST",
		path: "/api/auth/login",
		status: 400,
		reason: "Sign-in endpoint; an empty body is a validation error",
	},
	{
		method: "POST",
		path: "/api/auth/mfa/verify",
		status: 400,
		reason: "Second sign-in step, authenticated by a challenge token in the body",
	},
	{
		method: "POST",
		path: "/api/auth/passkey/options",
		status: 200,
		reason: "Starts a passkey sign-in: a single-use challenge, bound to the browser by an httpOnly cookie",
	},
	{
		method: "POST",
		path: "/api/auth/passkey/verify",
		status: 400,
		reason: "Passkey sign-in, authenticated by the signed assertion; an empty body is a validation error",
	},
	{
		method: "POST",
		path: "/api/auth/password-reset/request",
		status: 400,
		reason: "Anonymous by definition; an empty body is a validation error",
	},
	{
		method: "POST",
		path: "/api/auth/password-reset/confirm",
		status: 400,
		reason: "Authenticated by the reset token in the body",
	},
	{ method: "GET", path: "/api/public/booking", status: 400, reason: "Public booking page lookup; needs a slug" },
	{ method: "GET", path: "/api/public/booking/e2e_probe", status: 404, reason: "Public booking page; unknown slug" },
	{
		method: "POST",
		path: "/api/public/booking/e2e_probe",
		status: 404,
		reason: "Public booking request; unknown slug",
	},
	{
		method: "GET",
		path: "/api/public/calendar/feed/e2e_probe",
		status: 404,
		reason: "Calendar subscription feed; the token in the path is the credential",
	},
	{ method: "GET", path: "/api/public/drive/e2e_probe", status: 404, reason: "Drive public link; unknown token" },
	{
		method: "GET",
		path: "/api/public/drive/e2e_probe/content",
		status: 404,
		reason: "Drive public link download; unknown token",
	},
	{
		method: "POST",
		path: "/api/public/drive/e2e_probe/unlock",
		status: 404,
		reason: "Drive public link password; unknown token",
	},
	{
		method: "GET",
		path: "/api/auth/accounts/e2e_probe/avatar",
		status: 404,
		reason: "Avatar on the account chooser; unknown account",
	},
	{
		method: "GET",
		path: "/api/shared-files/e2e_probe",
		status: 404,
		reason: "Capability link to a shared file; unknown id",
	},
	{
		method: "GET",
		path: "/api/accounts/e2e_probe/mailbox-access",
		status: 410,
		reason: "Retired endpoint, answers 410 Gone before any lookup",
	},
	{
		method: "POST",
		path: "/api/accounts/e2e_probe/mailbox-access",
		status: 410,
		reason: "Retired endpoint, answers 410 Gone before any lookup",
	},
	{
		method: "DELETE",
		path: "/api/accounts/e2e_probe/mailbox-access",
		status: 410,
		reason: "Retired endpoint, answers 410 Gone before any lookup",
	},
	{
		method: "POST",
		path: "/api/inbound",
		status: 503,
		reason: "Relay webhook, signed with a shared secret that the e2e server does not configure",
	},
	{
		method: "POST",
		path: "/api/inbound/resend",
		status: 503,
		reason: "Resend webhook, verified with a secret that the e2e server does not configure",
	},
	{
		method: "OPTIONS",
		path: "/api/oauth/register",
		status: 204,
		reason: "CORS preflight of a cookie-free MCP OAuth endpoint, for browser-based MCP clients",
	},
	{
		method: "POST",
		path: "/api/oauth/register",
		status: 400,
		reason:
			"Dynamic Client Registration for MCP apps (RFC 7591); grants nothing until a user consents; an empty body is a validation error",
	},
	{
		method: "OPTIONS",
		path: "/api/oauth/token",
		status: 204,
		reason: "CORS preflight of a cookie-free MCP OAuth endpoint, for browser-based MCP clients",
	},
	{
		method: "POST",
		path: "/api/oauth/token",
		status: 400,
		reason:
			"OAuth token endpoint for MCP apps, authenticated by the code with PKCE or the refresh token in the body; an empty body is a validation error",
	},
	{
		method: "OPTIONS",
		path: "/api/oauth/revoke",
		status: 204,
		reason: "CORS preflight of a cookie-free MCP OAuth endpoint, for browser-based MCP clients",
	},
	{
		method: "POST",
		path: "/api/oauth/revoke",
		status: 400,
		reason:
			"OAuth token revocation for MCP apps, authenticated by the token in the body; an empty body is a validation error",
	},
];
