import type { ClientModuleData } from "../module-types";

/** The slice of the finance manifest that client code reads, so client bundles never carry the rest of it. */
export const financeClientData: ClientModuleData = {
	id: "finance",
	name: "Money Watch",
	keyScopes: {
		mcp: [
			{
				scope: "mcp:finance-read",
				mailboxBound: false,
				label: "Read subscriptions",
				description: "List tracked subscriptions and renewals",
			},
		],
		api: [],
	},
	nav: [],
	commands: [
		{
			id: "finance.open",
			moduleId: "finance",
			label: "Open Subscriptions",
			description: "Show tracked subscriptions and renewals",
			keywords: ["finance", "money", "subscriptions", "renewals", "bills", "trials"],
			group: "Money Watch",
			target: { type: "route", href: "/finance" },
			effect: "navigate",
		},
	],
};
