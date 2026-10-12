import { bookingSchemas } from "./booking/schemas";
import { bookingHandlers } from "./booking/server";
import { calendarSchemas } from "./calendar/schemas";
import { calendarHandlers } from "./calendar/server";
import { importSchemas } from "./import/schemas";
import { importHandlers } from "./import/server";
import type { CapabilityHandler, ModuleId } from "./module-types";
import type { ModuleSchemas } from "./schema-utils";
import { templatesSchemas } from "./templates/schemas";
import { templatesHandlers } from "./templates/server";

export type ServerModule = { handlers: Record<string, CapabilityHandler>; schemas: ModuleSchemas };

/** Imported only by `invoke.ts`; every builtin module is a static import on both runtimes. */
export const SERVER_MODULES: Record<ModuleId, ServerModule> = {
	calendar: { handlers: calendarHandlers, schemas: calendarSchemas },
	booking: { handlers: bookingHandlers, schemas: bookingSchemas },
	templates: { handlers: templatesHandlers, schemas: templatesSchemas },
	import: { handlers: importHandlers, schemas: importSchemas },
};
