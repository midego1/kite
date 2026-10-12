import type { ModuleManifest } from "../module-types";
import { importClientData } from "../client-data/import";

export const importManifest: ModuleManifest = {
	id: "import",
	name: importClientData.name,
	description: "Bring mail in from an IMAP server or from mbox and eml files, including background IMAP jobs.",
	runtime: "builtin",
	dependsOn: [],
	defaultEnabled: true,
	pages: [{ prefix: "/settings/import" }],
	apiPrefixes: [{ prefix: "/api/import" }],
	nav: importClientData.nav,
	commands: importClientData.commands,
	composerSlots: [],
	recordKinds: [{ kind: "import:job", label: "Import job", unavailableLabel: "Import" }],
	webhookEvents: [],
	grants: [{ grant: "import.run", label: "Import mail and run import jobs" }],
	mcpScopes: [],
	apiKeyScopes: [],
	jmapCapabilities: [],
	searchSections: [],
	messageStatuses: [],
	queueMessageTypes: [{ kind: "import.imap", queue: "agent", capability: "processImportJob", metricClass: "import" }],
	cronTasks: [{ name: "resumeStalledImports", schedule: "every_tick", capability: "resumeStalledImports" }],
	actionLabels: {},
	reasonTexts: { "module_disabled:import": "Mail import is turned off" },
	adminNotes: [
		"Turning this off pauses running imports. They keep their saved source credentials until they finish or are cancelled, and resume within about five minutes of turning it back on.",
	],
};
