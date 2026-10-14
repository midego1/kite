import type { ModuleManifest } from "../module-types";
import { financeClientData, SUBSCRIPTION_REASONS } from "../client-data/finance";

export const financeManifest: ModuleManifest = {
	id: "finance",
	name: financeClientData.name,
	description:
		"Finds subscriptions in receipts and invoices, keeps their invoices, payments and refunds, and reminds you before they renew.",
	runtime: "builtin",
	dependsOn: [],
	defaultEnabled: true,
	pages: [{ prefix: "/finance" }],
	apiPrefixes: [{ prefix: "/api/finance" }],
	nav: financeClientData.nav,
	commands: financeClientData.commands,
	composerSlots: [],
	recordKinds: [{ kind: "finance:subscription", label: "Subscription", unavailableLabel: "Subscription" }],
	webhookEvents: [
		{
			value: "finance.subscription.detected",
			label: "Subscription detected",
			hint: "A subscription was added to Money Watch",
		},
		{
			value: "finance.subscription.renewal_due",
			label: "Subscription renewal due",
			hint: "A tracked subscription renews or its trial ends soon",
		},
	],
	grants: [
		{ grant: "finance.read", label: "Read subscriptions" },
		{ grant: "finance.write", label: "Add, change and remove subscriptions and their documents" },
	],
	mcpScopes: [
		{ scope: "mcp:finance-read", label: "Read subscriptions", grants: ["finance.read"], mailboxBound: false },
	],
	apiKeyScopes: [],
	jmapCapabilities: [],
	searchSections: [],
	messageStatuses: [],
	queueMessageTypes: [],
	cronTasks: [{ name: "remindRenewals", schedule: "*/5 * * * *", capability: "remindRenewals" }],
	actionLabels: {},
	reasonTexts: {
		...SUBSCRIPTION_REASONS,
		"module_disabled:finance": "Money Watch is turned off",
		migration_pending: "The database update for Money Watch has not been applied yet",
	},
};
