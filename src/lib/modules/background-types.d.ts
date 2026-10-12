import type {
	CapabilityCallContext,
	CapabilityResult,
	JsonValue,
	ModuleId,
	ModuleManifest,
	ModuleQueueName,
} from "./module-types";

/** The part of a manifest that background dispatch reads. */
export type BackgroundManifest = Pick<ModuleManifest, "queueMessageTypes" | "cronTasks"> & { id: ModuleId };

export type BackgroundLogger = {
	debug(message: string, fields: Record<string, unknown>): void;
	info(message: string, fields: Record<string, unknown>): void;
	warn(message: string, fields: Record<string, unknown>): void;
};

export type BackgroundDeps = {
	manifests: readonly BackgroundManifest[];
	invoke(moduleId: ModuleId, name: string, input: JsonValue, ctx: CapabilityCallContext): Promise<CapabilityResult>;
	/** The grants a descriptor declares; background work holds them for the one call it makes. */
	descriptorScopes(moduleId: ModuleId, name: string): string[];
	log: BackgroundLogger;
};

/** `handled: false` means no manifest claims the message, so the consumer keeps looking. */
export type QueueDispatchResult = { handled: false } | { handled: true; result: CapabilityResult };

export type { ModuleQueueName };
