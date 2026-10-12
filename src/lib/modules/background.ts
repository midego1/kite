import { createLogger } from "@/lib/logger.mjs";
import { findDescriptor } from "./capability-registry";
import { createModuleBackground } from "./background-utils";
import { invokeCapability } from "./invoke";
import { MODULE_MANIFESTS } from "./registry";

const log = createLogger("modules");

/**
 * The entry points of background work: queue consumers call `dispatchModuleQueueMessage`, cron
 * triggers call `runModuleCronTasks`. Both reach module code through `invokeCapability` only.
 */
export const { dispatchModuleQueueMessage, runModuleCronTasks } = createModuleBackground({
	manifests: MODULE_MANIFESTS,
	invoke: invokeCapability,
	descriptorScopes: (moduleId, name) => findDescriptor(moduleId, name)?.scopes ?? [],
	log: {
		debug: (message, fields) => log.debug(message, fields),
		info: (message, fields) => log.info(message, fields),
		warn: (message, fields) => log.warn(message, fields),
	},
});
