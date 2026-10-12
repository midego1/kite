import type { ModuleManifest } from "../module-types";
import { templatesClientData } from "../client-data/templates";

export const templatesManifest: ModuleManifest = {
	id: "templates",
	name: templatesClientData.name,
	description: "Save a message as a template and insert it from the composer's send menu.",
	runtime: "builtin",
	dependsOn: [],
	defaultEnabled: true,
	pages: [],
	apiPrefixes: [{ prefix: "/api/templates" }],
	nav: templatesClientData.nav,
	commands: templatesClientData.commands,
	composerSlots: [{ id: "templates.send-menu", slot: "send-menu", order: 10, label: "Template" }],
	recordKinds: [{ kind: "templates:template", label: "Email template", unavailableLabel: "Template" }],
	webhookEvents: [],
	grants: [
		{ grant: "templates.read", label: "Read email templates" },
		{ grant: "templates.write", label: "Create and delete email templates" },
	],
	mcpScopes: [],
	apiKeyScopes: [],
	jmapCapabilities: [],
	searchSections: [],
	messageStatuses: ["template"],
	queueMessageTypes: [],
	cronTasks: [],
	actionLabels: {},
	reasonTexts: { "module_disabled:templates": "Email templates are turned off" },
};
