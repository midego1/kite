import { CORE_API_KEY_SCOPES, CORE_MCP_SCOPES } from "@/lib/api/scopes";
import type { ListedCapability } from "./capability-utils";
import type { ClientModuleData, ModuleId, ModuleManifest } from "./module-types";

export type KeyScopeKind = "mcp" | "api";

/** The key scopes one module adds. Module API key scopes never name a mailbox. */
export type ScopeDeclaration = {
	id: ModuleId;
	name: string;
	mcp: readonly { scope: string; mailboxBound: boolean }[];
	api: readonly string[];
};

export type ScopeRefusal = {
	status: 400;
	body: { error: string; code: "MODULE_DISABLED"; moduleId: ModuleId };
};

export function scopeDeclarations(
	manifests: readonly Pick<ModuleManifest, "id" | "name" | "mcpScopes" | "apiKeyScopes">[],
): ScopeDeclaration[] {
	return manifests.map((manifest) => ({
		id: manifest.id,
		name: manifest.name,
		mcp: manifest.mcpScopes.map(({ scope, mailboxBound }) => ({ scope, mailboxBound })),
		api: manifest.apiKeyScopes.map(({ scope }) => scope),
	}));
}

export function clientScopeDeclarations(modules: readonly ClientModuleData[]): ScopeDeclaration[] {
	return modules.map((module) => ({
		id: module.id,
		name: module.name,
		mcp: module.keyScopes?.mcp ?? [],
		api: module.keyScopes?.api ?? [],
	}));
}

const scopesOf = (declaration: ScopeDeclaration, kind: KeyScopeKind): string[] =>
	kind === "mcp" ? declaration.mcp.map((item) => item.scope) : [...declaration.api];

/** Every module's scopes, on or off, so a key keeps authenticating while its module is off. */
function registeredScopes(declarations: readonly ScopeDeclaration[], kind: KeyScopeKind): string[] {
	return declarations.flatMap((declaration) => scopesOf(declaration, kind));
}

/** Core scopes followed by every module's, for validators and authentication. */
export function allKeyScopes(declarations: readonly ScopeDeclaration[], kind: KeyScopeKind): string[] {
	const core: readonly string[] = kind === "mcp" ? CORE_MCP_SCOPES : CORE_API_KEY_SCOPES;
	return [...core, ...registeredScopes(declarations, kind)];
}

export function scopeOwner(
	declarations: readonly ScopeDeclaration[],
	kind: KeyScopeKind,
	scope: string,
): ModuleId | null {
	return declarations.find((declaration) => scopesOf(declaration, kind).includes(scope))?.id ?? null;
}

/** A core scope, or a module scope whose module is in `enabled`. */
export function isScopeAvailable(
	declarations: readonly ScopeDeclaration[],
	kind: KeyScopeKind,
	scope: string,
	enabled: Iterable<ModuleId>,
): boolean {
	const owner = scopeOwner(declarations, kind, scope);
	return owner === null || [...enabled].includes(owner);
}

/** Whether a key with this scope must name mailboxes. Only module scopes can say no. */
function scopeNeedsMailbox(declarations: readonly ScopeDeclaration[], kind: KeyScopeKind, scope: string): boolean {
	if (scopeOwner(declarations, kind, scope) === null) return true;
	if (kind === "api") return false;
	return declarations.some((declaration) => declaration.mcp.some((item) => item.scope === scope && item.mailboxBound));
}

export function scopesNeedMailbox(
	declarations: readonly ScopeDeclaration[],
	kind: KeyScopeKind,
	scopes: readonly string[],
): boolean {
	return scopes.some((scope) => scopeNeedsMailbox(declarations, kind, scope));
}

/** The 400 `MODULE_DISABLED` answer for a new key that asks for the scope of a module that is off for its creator. */
export function scopeRefusal(
	declarations: readonly ScopeDeclaration[],
	kind: KeyScopeKind,
	scopes: readonly string[],
	enabled: Iterable<ModuleId>,
): ScopeRefusal | null {
	const on = [...enabled];
	for (const scope of scopes) {
		const owner = scopeOwner(declarations, kind, scope);
		if (owner === null || on.includes(owner)) continue;
		const name = declarations.find((declaration) => declaration.id === owner)?.name ?? owner;
		return { status: 400, body: { error: `${name} is turned off`, code: "MODULE_DISABLED", moduleId: owner } };
	}
	return null;
}

/** The grants an MCP key holds through its scopes, which the module tools it may call must all be covered by. */
export function grantsForMcpScopes(
	manifests: readonly Pick<ModuleManifest, "mcpScopes">[],
	scopes: readonly string[],
): string[] {
	const held = new Set(scopes);
	return [
		...new Set(
			manifests.flatMap((manifest) =>
				manifest.mcpScopes.filter((item) => held.has(item.scope)).flatMap((item) => item.grants),
			),
		),
	];
}

/** The tools a key may see: a tool that names no grant is never offered, and every grant it names must be held. */
export function mcpToolsFor(listed: readonly ListedCapability[], grants: readonly string[]): ListedCapability[] {
	return listed.filter(
		({ descriptor }) => !!descriptor.scopes?.length && descriptor.scopes.every((scope) => grants.includes(scope)),
	);
}
