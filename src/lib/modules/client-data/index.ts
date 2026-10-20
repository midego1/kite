import type { ClientModuleData } from "../module-types";
import { bookingClientData } from "./booking";
import { calendarClientData } from "./calendar";
import { driveClientData } from "./drive";
import { financeClientData } from "./finance";
import { importClientData } from "./import";
import { templatesClientData } from "./templates";

/** What client code reads of each module, in registry order. Components import this, never the manifests. */
export const CLIENT_MODULES: readonly ClientModuleData[] = [
	calendarClientData,
	bookingClientData,
	templatesClientData,
	importClientData,
	financeClientData,
	driveClientData,
];
