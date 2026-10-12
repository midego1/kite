import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import type { ModuleId } from "./module-types";
import type { ModuleGuardChecks, ModuleRouteHandler } from "./route-guard-types";
import { guardRoute, pageAccess, publicPageAccess } from "./route-guard-utils";
import { isModuleEnabled, isModuleEnabledFor } from "./state";

const storedState: ModuleGuardChecks = {
	installEnabled: (id) => isModuleEnabled(getEnv(), id),
	userEnabled: (id, user) =>
		isModuleEnabledFor(getEnv(), { userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin }, id),
	async hostEnabled(id, hostUserId) {
		const env = getEnv();
		const [host] = await getDb(env)
			.select({ role: users.role, isPrimaryAdmin: users.isPrimaryAdmin })
			.from(users)
			.where(eq(users.id, hostUserId))
			.limit(1);
		// An unknown host is the route's own 404 to give.
		return host ? isModuleEnabledFor(env, { userId: hostUserId, ...host }, id) : true;
	},
};

/**
 * Guards every exported method of a route under a module's `apiPrefixes`: 404 `{ error: "Not found" }`
 * before authentication when the module is off for the install, then the handler, which calls
 * `checkUser(user)` (or `checkHost(id)` on a public route) once it knows who is asking.
 */
export function withModule<C extends object = object>(id: ModuleId, handler: ModuleRouteHandler<C>) {
	return guardRoute<C>(storedState, id, handler);
}

/**
 * For a module's server layout: renders the not-found page when the module is off for the install, or off for
 * the signed-in user. With no session it returns, so the page's own sign-in redirect still applies.
 */
export async function requireModulePage(id: ModuleId, parent?: ModuleId): Promise<void> {
	const user = await getCurrentUser(getEnv());
	const access = await pageAccess(storedState, id, user);
	if (access !== "off" && access !== "restricted") return;
	// vinext renders each layout on its own, so a layout nested under the parent module's one must stay quiet
	// when the parent answers not-found already; two layouts throwing at once end in the framework's bare 404.
	if (parent) {
		const parentAccess = await pageAccess(storedState, parent, user);
		if (parentAccess === "off" || parentAccess === "restricted") return;
	}
	notFound();
}

/**
 * For a public module page (`/book/*`, `/c/*`): visitors have no session, so the install switch and the
 * host's access decide. `host` is the user id or the booking username from the URL.
 */
export async function requirePublicModulePage(
	id: ModuleId,
	host: { userId: string } | { username: string },
): Promise<void> {
	const env = getEnv();
	const access = await publicPageAccess(storedState, id, () => hostIdFor(env, host));
	if (access === "off" || access === "restricted") notFound();
}

async function hostIdFor(env: CloudflareEnv, host: { userId: string } | { username: string }): Promise<string | null> {
	if ("userId" in host) return host.userId;
	const [row] = await getDb(env)
		.select({ id: users.id })
		.from(users)
		.where(eq(users.bookingUsername, host.username.toLowerCase()))
		.limit(1);
	return row?.id ?? null;
}

/** Where a legacy redirect page sends the viewer: `onHref` when the module is on for them (the install, for a visitor), else `offHref`. */
export async function hrefForModule(id: ModuleId, onHref: string, offHref: string): Promise<string> {
	const access = await pageAccess(storedState, id, await getCurrentUser(getEnv()));
	return access === "open" || access === "signed-out" ? onHref : offHref;
}
