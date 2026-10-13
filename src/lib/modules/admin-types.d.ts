import type { ModuleId } from "./module-types";

type ModuleRef = { id: ModuleId; name: string };

export type ModuleAdminCapabilities = {
	/** Assistant chat and MCP tools. */
	tools: { name: string; description: string }[];
	/** MCP scopes and REST API key scopes the module adds. */
	scopes: { scope: string; label: string; kind: "mcp" | "api_key" }[];
	webhookEvents: { value: string; label: string }[];
	commands: { id: string; label: string }[];
};

export type RestrictedUser = { id: string; name: string; email: string };

export type ModuleAdminEntry = {
	id: ModuleId;
	name: string;
	description: string;
	dependsOn: ModuleRef[];
	/** The modules that need this one. */
	dependents: ModuleRef[];
	/** The stored install switch, which a dependency being off never rewrites. */
	enabled: boolean;
	/** On for the install once dependencies are applied. */
	effective: boolean;
	/** The nearest dependency that is off, when that is why the module is off. */
	offBecause: ModuleRef | null;
	adminNotes: string[];
	capabilities: ModuleAdminCapabilities;
	restrictedUsers: RestrictedUser[];
};

export type ModuleAdminView = {
	/** Migration 0062 is not applied, so every module reads as on and nothing can be changed. */
	migrationPending: boolean;
	modules: ModuleAdminEntry[];
};

export type UserModuleAccessView = {
	migrationPending: boolean;
	modules: { id: ModuleId; name: string; description: string; installEnabled: boolean; allowed: boolean }[];
};

export type ModuleAdminFailure = { ok: false; status: number; code: string; error: string };
