import type { ModuleClient } from "../client-registry-types";

/** Opens the calendar's new event dialog; the calendar page reads the param and drops it. */
export const commandHandlers: NonNullable<ModuleClient["commandHandlers"]> = {
	newEvent: ({ navigate }) => navigate("/calendar?new=event"),
};
