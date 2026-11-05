import type {
	CapabilityCallContext,
	CapabilityDescriptor,
	CapabilitySurface,
	ModuleCapabilities,
	ModuleId,
	ModuleManifest,
} from "./module-types";

/** Surfaces that only declare something; core never invokes them. */
const DECLARATION_ONLY: readonly CapabilitySurface[] = ["webhook_event", "suggestion_kind", "jmap_capability"];

/** @public Test-only: no production caller yet. */
export function isInvokableDescriptor(descriptor: Pick<CapabilityDescriptor, "surfaces">): boolean {
	return descriptor.surfaces.some((surface) => !DECLARATION_ONLY.includes(surface));
}

/** Only the two tool surfaces describe the same call, so only they may share a descriptor. @public Test-only: no production caller yet. */
export function surfacesAreCombinable(surfaces: readonly CapabilitySurface[]): boolean {
	if (surfaces.length === 0) return false;
	if (new Set(surfaces).size !== surfaces.length) return false;
	return surfaces.length === 1 || surfaces.every((surface) => surface === "assistant_tool" || surface === "mcp_tool");
}

/** Effects an assistant tool may only have once the user approved the call in chat. */
const APPROVAL_EFFECTS: readonly CapabilityDescriptor["effect"][] = ["update", "delete", "send"];

/**
 * Whether a module's assistant tool is proposed in chat and runs only after the user approves it: it changes or
 * removes data, or sends, or its descriptor asks for approval.
 */
export function needsChatApproval(descriptor: Pick<CapabilityDescriptor, "effect" | "approval">): boolean {
	return !!descriptor.approval || APPROVAL_EFFECTS.includes(descriptor.effect);
}

export type ListedCapability = { moduleId: ModuleId; descriptor: CapabilityDescriptor };

/** The descriptors for one surface from the enabled modules, in registry order. */
export function selectCapabilities(
	all: readonly ModuleCapabilities[],
	surface: CapabilitySurface,
	enabled: Iterable<ModuleId>,
): ListedCapability[] {
	const on = new Set(enabled);
	return all.flatMap((entry) =>
		on.has(entry.moduleId)
			? entry.descriptors
					.filter((descriptor) => descriptor.surfaces.includes(surface))
					.map((descriptor) => ({ moduleId: entry.moduleId, descriptor }))
			: [],
	);
}

type PromptValues = { timeZone: string; today: string };

/** Fills the two placeholders a prompt fragment may use. */
function fillPromptFragment(fragment: string, values: PromptValues): string {
	return fragment.replaceAll("{timeZone}", values.timeZone).replaceAll("{today}", values.today);
}

/** The prompt fragments of the enabled modules, in registry order, with the placeholders filled. */
export function selectPromptFragments(
	all: readonly ModuleCapabilities[],
	enabled: Iterable<ModuleId>,
	values: PromptValues,
): string[] {
	const on = new Set(enabled);
	return all.flatMap((entry) =>
		on.has(entry.moduleId) && entry.promptFragment ? [fillPromptFragment(entry.promptFragment, values)] : [],
	);
}

/** Every grant of every enabled module, which a signed-in user holds over their own records. */
function sessionGrants(manifests: readonly Pick<ModuleManifest, "id" | "grants">[], enabled: Iterable<ModuleId>) {
	const on = new Set(enabled);
	return [
		...new Set(manifests.filter((manifest) => on.has(manifest.id)).flatMap((m) => m.grants.map((item) => item.grant))),
	];
}

type CallContextInput = {
	trigger: CapabilityCallContext["trigger"];
	viewer: CapabilityCallContext["viewer"];
	timeZone: string;
	locale?: string;
	requestId?: string;
	mailboxIds?: string[];
	/** Modules on for the viewer; a session trigger (`chat`, `api`) holds all of their grants. */
	enabled?: Iterable<ModuleId>;
	manifests?: readonly Pick<ModuleManifest, "id" | "grants">[];
	/** Replaces the grant set, for the triggers that do not hold a session's rights (MCP keys, auto read). */
	grants?: string[];
};

/** Builds the JSON call context for a trigger; the other triggers must name their grants. */
export function buildCallContext(input: CallContextInput): CapabilityCallContext {
	const session = input.trigger === "chat" || input.trigger === "api";
	const grants = input.grants ?? (session ? sessionGrants(input.manifests ?? [], input.enabled ?? []) : []);
	return {
		viewer: input.viewer,
		requestId: input.requestId ?? crypto.randomUUID(),
		locale: input.locale ?? "en",
		timeZone: input.timeZone,
		grants,
		...(input.mailboxIds ? { mailboxIds: input.mailboxIds } : {}),
		trigger: input.trigger,
	};
}
