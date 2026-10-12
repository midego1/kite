import { createLogger } from "@/lib/logger.mjs";
import { MODULE_CAPABILITIES } from "./capability-registry";
import { invokeCapability } from "./invoke";
import { createLifecycleEmitter } from "./lifecycle-utils";

const log = createLogger("modules");

/**
 * Tells the modules that a user was created or changed time zone. Call it after the core write has
 * committed: a failing hook is logged here and never throws, and a data hook runs even while its module is off.
 */
export const emitLifecycleEvent = createLifecycleEmitter({
	capabilities: MODULE_CAPABILITIES,
	invoke: invokeCapability,
	log: (message, fields) => log.warn(message, fields),
});
