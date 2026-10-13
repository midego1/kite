import type { ClientModuleData } from "../module-types";

/** The slice of the templates manifest that client code reads, so client bundles never carry the rest of it. */
export const templatesClientData: ClientModuleData = {
	id: "templates",
	name: "Email templates",
	nav: [],
	commands: [],
	composerSlots: [{ id: "templates.send-menu", slot: "send-menu", order: 10, label: "Template" }],
};
