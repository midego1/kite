import type { ModuleId } from "./module-types";
import type { ModuleGuard, ModuleGuardChecks, ModulePageAccess, ModuleRouteHandler } from "./route-guard-types";

function notFoundResponse(): Response {
	return Response.json({ error: "Not found" }, { status: 404 });
}

/**
 * Wraps a route handler for a module. With the module off for the install it answers 404 before the handler
 * runs, authentication included, so every caller sees the same thing. Otherwise the handler runs and
 * authenticates as it always did; `checkUser` and `checkHost` then answer for per-user restrictions.
 */
export function guardRoute<C extends object = object>(
	checks: ModuleGuardChecks,
	id: ModuleId,
	handler: ModuleRouteHandler<C>,
): (request: Request, context: C) => Promise<Response> {
	const guard: ModuleGuard = {
		checkUser: async (user) => ((await checks.userEnabled(id, user)) ? null : notFoundResponse()),
		checkAuth: async (pending) => {
			const auth = await pending;
			if (auth.error || !auth.user || (await checks.userEnabled(id, auth.user))) return auth;
			return { ...auth, user: null, error: notFoundResponse() };
		},
		checkHost: async (hostUserId) => ((await checks.hostEnabled(id, hostUserId)) ? null : notFoundResponse()),
	};
	return async (request, context) => {
		if (!(await checks.installEnabled(id))) return notFoundResponse();
		return handler(request, { ...context, ...guard });
	};
}

/**
 * The order spec §10.1 sets for pages: install off is absent for everyone, signed in or not. With no session
 * the page stays so the existing sign-in redirect applies; a signed-in user the module is off for gets not-found.
 */
export async function pageAccess(
	checks: Pick<ModuleGuardChecks, "installEnabled" | "userEnabled">,
	id: ModuleId,
	user: { id: string; role: string; isPrimaryAdmin: boolean } | null,
): Promise<ModulePageAccess> {
	if (!(await checks.installEnabled(id))) return "off";
	if (!user) return "signed-out";
	return (await checks.userEnabled(id, user)) ? "open" : "restricted";
}

/** Public pages have no viewer: the install switch and the host's own access decide. */
export async function publicPageAccess(
	checks: Pick<ModuleGuardChecks, "installEnabled" | "hostEnabled">,
	id: ModuleId,
	findHostUserId: () => Promise<string | null>,
): Promise<ModulePageAccess> {
	if (!(await checks.installEnabled(id))) return "off";
	const hostUserId = await findHostUserId();
	if (hostUserId && !(await checks.hostEnabled(id, hostUserId))) return "restricted";
	return "open";
}
