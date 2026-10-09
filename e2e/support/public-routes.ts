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
];
