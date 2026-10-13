import type { ModuleAdminCapabilities, ModuleAdminEntry, RestrictedUser } from "./admin-types";
import type { CapabilityDescriptor, ModuleCapabilities, ModuleId, ModuleManifest } from "./module-types";
import { effectiveModules } from "./state-utils";

/** The audit actions the Modules admin writes; Activity lists them next to sign-ins. */
export const MODULE_AUDIT_ACTIONS = ["module.enabled", "module.disabled", "module.user_access"] as const;

type Named = Pick<ModuleManifest, "id" | "name" | "dependsOn" | "defaultEnabled">;

const TOOL_SURFACES = ["assistant_tool", "mcp_tool"] as const;

/**
 * What a module adds to the rest of Kite, read from its manifest and its JSON-only descriptors.
 * @public Test-only: `buildModuleAdminEntries` is the production caller.
 */
export function summarizeCapabilities(
	manifest: Pick<ModuleManifest, "mcpScopes" | "apiKeyScopes" | "webhookEvents" | "commands">,
	descriptors: readonly Pick<CapabilityDescriptor, "name" | "description" | "surfaces">[],
): ModuleAdminCapabilities {
	return {
		tools: descriptors
			.filter((descriptor) => descriptor.surfaces.some((surface) => TOOL_SURFACES.includes(surface as never)))
			.map(({ name, description }) => ({ name, description })),
		scopes: [
			...manifest.mcpScopes.map(({ scope, label }) => ({ scope, label, kind: "mcp" as const })),
			...manifest.apiKeyScopes.map(({ scope, label }) => ({ scope, label, kind: "api_key" as const })),
		],
		webhookEvents: manifest.webhookEvents.map(({ value, label }) => ({ value, label })),
		commands: manifest.commands.map(({ id, label }) => ({ id, label })),
	};
}

/**
 * The nearest dependency of a module that is not on for the install, or null. A dependency counts as
 * off when its own dependency is off, so turning Booking on is refused whichever link in the chain is down.
 */
export function blockingDependency<T extends Named>(
	manifests: readonly T[],
	install: ReadonlyMap<ModuleId, boolean>,
	id: ModuleId,
): { id: ModuleId; name: string } | null {
	const on = effectiveModules(install, new Map(), manifests);
	const dependency = manifests.find(
		(manifest) => !on.has(manifest.id) && manifests.find((item) => item.id === id)?.dependsOn.includes(manifest.id),
	);
	return dependency ? { id: dependency.id, name: dependency.name } : null;
}

/** The entries of the Modules page, in registry order. */
export function buildModuleAdminEntries(input: {
	manifests: readonly ModuleManifest[];
	capabilities: readonly ModuleCapabilities[];
	install: ReadonlyMap<ModuleId, boolean>;
	restricted: readonly (RestrictedUser & { moduleId: string })[];
}): ModuleAdminEntry[] {
	const { manifests, capabilities, install, restricted } = input;
	const on = effectiveModules(install, new Map(), manifests);
	const ref = (id: ModuleId) => ({ id, name: manifests.find((manifest) => manifest.id === id)?.name ?? id });
	return manifests.map((manifest) => {
		const descriptors = capabilities.find((entry) => entry.moduleId === manifest.id)?.descriptors ?? [];
		return {
			id: manifest.id,
			name: manifest.name,
			description: manifest.description,
			dependsOn: manifest.dependsOn.map(ref),
			dependents: manifests.filter((other) => other.dependsOn.includes(manifest.id)).map((other) => ref(other.id)),
			enabled: install.get(manifest.id) ?? manifest.defaultEnabled,
			effective: on.has(manifest.id),
			offBecause: blockingDependency(manifests, install, manifest.id),
			adminNotes: manifest.adminNotes ?? [],
			capabilities: summarizeCapabilities(manifest, descriptors),
			restrictedUsers: restricted
				.filter((user) => user.moduleId === manifest.id)
				.map(({ id, name, email }) => ({ id, name, email })),
		};
	});
}

/**
 * The dependents that are on today, which a confirmation to turn the module off names.
 * @public Test-only: `turnOffWarning` is the production caller.
 */
export function dependentsTurningOff(
	entry: ModuleAdminEntry,
	entries: readonly ModuleAdminEntry[],
): ModuleAdminEntry["dependents"] {
	return entry.dependents.filter((dependent) => entries.find((other) => other.id === dependent.id)?.effective);
}

/** The warning shown before a module that others depend on is turned off. */
export function turnOffWarning(entry: ModuleAdminEntry, entries: readonly ModuleAdminEntry[]): string {
	const going = dependentsTurningOff(entry, entries);
	if (!going.length) {
		const names = entry.dependents.map((dependent) => dependent.name).join(" and ");
		return `${names} needs ${entry.name} and is already off, so it stays off.`;
	}
	const names = going.map((dependent) => dependent.name).join(" and ");
	return `${names} needs ${entry.name}, so ${names} will be turned off too. ${names} keeps its own setting and comes back when ${entry.name} is turned on again.`;
}

/** One line for the per-user summary on a module's card. */
export function accessSummary(entry: ModuleAdminEntry): string {
	const count = entry.restrictedUsers.length;
	if (!count) return "Every user has access.";
	const names = entry.restrictedUsers.map((user) => user.name || user.email).join(", ");
	return `${count} ${count === 1 ? "user is" : "users are"} restricted: ${names}.`;
}
