import type { ClientModuleData } from "../module-types";

const KEYWORDS = ["drive", "files", "folders", "documents", "upload", "storage", "share"];

/** The slice of the Drive manifest that client code reads, so client bundles never carry the rest of it. */
export const driveClientData: ClientModuleData = {
	id: "drive",
	name: "Drive",
	nav: [
		{
			id: "drive.mailbox-selector",
			label: "Drive",
			href: "/drive",
			icon: "HardDrive",
			placement: "mailbox-selector",
			order: 30,
		},
		{
			id: "drive.files",
			label: "Drive",
			href: "/drive",
			icon: "HardDrive",
			placement: "sidebar",
			keywords: KEYWORDS,
			order: 30,
		},
	],
	commands: [
		{
			id: "drive.open",
			moduleId: "drive",
			label: "Open Drive",
			description: "Show your files and folders",
			keywords: KEYWORDS,
			group: "Drive",
			target: { type: "route", href: "/drive" },
			effect: "navigate",
		},
	],
};
