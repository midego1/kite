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
	messageSlots: financeClientData.messageSlots,
	readingPaneSlots: financeClientData.readingPaneSlots,
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
	searchSections: financeClientData.searchSections ?? [],
	messageStatuses: [],
	queueMessageTypes: [],
	cronTasks: [{ name: "remindRenewals", schedule: "*/5 * * * *", capability: "remindRenewals" }],
	actionLabels: {
		create_subscription: "Started tracking a subscription",
		"create_subscription:update": "Updated a tracked subscription from a new invoice",
		update_subscription: "Changed a subscription",
		"update_subscription:reminder": "Changed a subscription reminder",
		"update_subscription:payment_failed": "Marked a subscription payment as failed",
		set_subscription_status: "Changed a subscription's status",
		"set_subscription_status:cancelled": "Marked a subscription as cancelled",
		"set_subscription_status:active": "Marked a subscription as active",
		"set_subscription_status:expired": "Marked a subscription as expired",
		"set_subscription_status:trial": "Marked a subscription as a trial",
		delete_subscription: "Removed a subscription",
		record_document: "Recorded a subscription document",
		"record_document:invoice": "Recorded an invoice",
		"record_document:payment": "Recorded a payment",
		"record_document:credit": "Recorded a credit note",
		"record_document:refund": "Recorded a refund",
		delete_document: "Removed a subscription document",
	},
	reasonTexts: {
		...SUBSCRIPTION_REASONS,
		"module_disabled:finance": "Money Watch is turned off",
		migration_pending: "The database update for Money Watch has not been applied yet",
	},
};
