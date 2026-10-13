import type {
	CapabilityCallContext,
	CapabilityDescriptor,
	CapabilityResult,
	JsonValue,
	ModuleId,
} from "./module-types";

/** What core announces to modules, as the JSON a lifecycle capability receives. */
export type LifecycleEvent =
	| { type: "user.created"; userId: string }
	| { type: "user.time_zone_changed"; userId: string; from: string | null; to: string };

export type LifecycleEventType = LifecycleEvent["type"];

export type LifecycleTarget = { moduleId: ModuleId; descriptor: CapabilityDescriptor };

export type LifecycleEmitterDeps = {
	capabilities: readonly { moduleId: ModuleId; descriptors: readonly CapabilityDescriptor[] }[];
	invoke: (moduleId: ModuleId, name: string, input: JsonValue, ctx: CapabilityCallContext) => Promise<CapabilityResult>;
	log: (message: string, fields: Record<string, unknown>) => void;
};
