import type { ModuleId } from "./module-types";

/** What a module question needs to know about a signed-in caller. */
export type ModuleGuardUser = { id: string; role: string; isPrimaryAdmin: boolean };

/** Passed to a guarded route handler next to Next's own context. */
export type ModuleGuard = {
	/** Answers 404 for a user restricted from the module, or `null`. Call it right after the route authenticates. */
	checkUser(user: ModuleGuardUser): Promise<Response | null>;
	/** `checkUser` folded into a route's own auth result, for handlers whose branch count has no room for another `if`. */
	checkAuth<T extends { user: ModuleGuardUser | null; error: Response | null }>(auth: T | Promise<T>): Promise<T>;
	/** The same for the user whose public page the request is for, which has no session. */
	checkHost(hostUserId: string): Promise<Response | null>;
};

export type ModuleRouteHandler<C extends object> = (
	request: Request,
	context: C & ModuleGuard,
) => Response | Promise<Response>;

/** The state questions a guard asks; the real ones read the stored module state. */
export type ModuleGuardChecks = {
	installEnabled(id: ModuleId): Promise<boolean>;
	userEnabled(id: ModuleId, user: ModuleGuardUser): Promise<boolean>;
	hostEnabled(id: ModuleId, hostUserId: string): Promise<boolean>;
};

/** Where a server layout stands for a module: absent for everyone, waiting for a sign-in, or open. */
export type ModulePageAccess = "off" | "signed-out" | "restricted" | "open";
