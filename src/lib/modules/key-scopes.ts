import type { SessionUser } from "@/lib/auth/types";
import {
	allKeyScopes,
	scopeDeclarations,
	scopeOwner,
	scopeRefusal,
	scopesNeedMailbox,
	type KeyScopeKind,
} from "./key-scope-utils";
import { MODULE_MANIFESTS } from "./registry";
import { listEnabledModules } from "./state";

const declarations = scopeDeclarations(MODULE_MANIFESTS);

/** Every scope a new key of this kind may name, whether its module is on or off; the creation routes validate against it. */
export function creatableKeyScopes(kind: KeyScopeKind): [string, ...string[]] {
	return allKeyScopes(declarations, kind) as [string, ...string[]];
}

/** Whether a key with these scopes must name mailboxes: module scopes declared mailbox-free do not. */
export function keyScopesNeedMailbox(kind: KeyScopeKind, scopes: readonly string[]): boolean {
	return scopesNeedMailbox(declarations, kind, scopes);
}

/** The 400 `MODULE_DISABLED` response for a new key that asks for a scope of a module that is off for its creator. */
export async function refuseDisabledKeyScopes(
	env: CloudflareEnv,
	user: Pick<SessionUser, "id" | "role" | "isPrimaryAdmin">,
	kind: KeyScopeKind,
	scopes: readonly string[],
): Promise<Response | null> {
	if (scopes.every((scope) => scopeOwner(declarations, kind, scope) === null)) return null;
	const enabled = await listEnabledModules(env, {
		userId: user.id,
		role: user.role,
		isPrimaryAdmin: user.isPrimaryAdmin,
	});
	const refusal = scopeRefusal(declarations, kind, scopes, enabled);
	return refusal ? Response.json(refusal.body, { status: refusal.status }) : null;
}
