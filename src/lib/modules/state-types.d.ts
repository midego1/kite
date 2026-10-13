import type { CapabilityCallContext, ModuleId } from "./module-types";

/** Who a module question is asked for. `null` means no one, as in cron, queue and webhook retries. */
export type ModuleViewer = NonNullable<CapabilityCallContext["viewer"]>;

/** One flag per module; every module in the registry has an entry. */
export type ModuleFlags = Map<ModuleId, boolean>;

export type ModuleFlagRow = { moduleId: string; flag: boolean };
