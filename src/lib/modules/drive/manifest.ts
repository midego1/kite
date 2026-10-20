import type { ModuleManifest } from "../module-types";
import { driveClientData } from "../client-data/drive";

export const driveManifest: ModuleManifest = {
	id: "drive",
	name: driveClientData.name,
	description:
		"Stores files and folders next to your mail, shares them with people on the install or by link, and saves attachments.",
	runtime: "builtin",
	dependsOn: [],
	defaultEnabled: true,
	pages: [{ prefix: "/drive" }, { prefix: "/d", public: true }],
	apiPrefixes: [{ prefix: "/api/drive" }, { prefix: "/api/public/drive", public: true }],
	nav: driveClientData.nav,
	commands: driveClientData.commands,
	attachmentSlots: driveClientData.attachmentSlots,
	composerSlots: [],
	recordKinds: [{ kind: "drive:file", label: "File", unavailableLabel: "File" }],
	webhookEvents: [],
	grants: [{ grant: "drive.read", label: "Read files" }],
	mcpScopes: [],
	apiKeyScopes: [],
	jmapCapabilities: [],
	searchSections: [],
	messageStatuses: [],
	queueMessageTypes: [],
	cronTasks: [{ name: "purgeDrive", schedule: "0 2 * * *", capability: "purgeDrive" }],
	actionLabels: {},
	reasonTexts: {
		"module_disabled:drive": "Drive is turned off",
		migration_pending: "The database update for Drive has not been applied yet",
	},
};
