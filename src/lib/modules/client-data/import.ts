import type { ClientModuleData } from "../module-types";

/** The slice of the import manifest that client code reads, so client bundles never carry the rest of it. */
export const importClientData: ClientModuleData = {
	id: "import",
	name: "Mail import",
	nav: [
		{
			id: "import.settings-nav",
			label: "Import",
			href: "/settings/import",
			icon: "Download",
			placement: "settings-nav",
			group: "Data",
			keywords: ["imap", "migrate"],
			order: 10,
		},
	],
	commands: [
		{
			id: "import.open",
			moduleId: "import",
			label: "Import mail",
			description: "Open the mail import settings",
			keywords: ["imap", "migrate", "mbox", "eml"],
			group: "Navigation",
			target: { type: "route", href: "/settings/import" },
			effect: "navigate",
		},
	],
};
