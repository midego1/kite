import type { ClientModuleData } from "../module-types";

/** Why a `subscription` card was offered, by reason code; the manifest's reason texts include these. */
export const SUBSCRIPTION_REASONS = {
	subscription: "The message looks like a subscription receipt, invoice or renewal notice",
	subscription_price_change: "The amount differs from the tracked subscription",
	subscription_payment_failed: "The message says a subscription payment failed",
	subscription_trial: "The message mentions a free trial ending",
	subscription_refund: "The message is a refund or credit note for a tracked subscription",
	subscription_check_amount: "The message could be read two ways; check the amount before tracking",
} as const;

/** The slice of the finance manifest that client code reads, so client bundles never carry the rest of it. */
export const financeClientData: ClientModuleData = {
	id: "finance",
	name: "Money Watch",
	suggestionKinds: ["subscription"],
	suggestionKindMeta: {
		subscription: {
			label: "Subscriptions",
			reason: SUBSCRIPTION_REASONS,
			badgePriority: 40,
			badgeLabel: "Subscription",
			icon: "WalletCards",
		},
	},
	triageSwitches: [{ key: "subscriptions", label: "Subscriptions in receipts (Money Watch)" }],
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
	nav: [
		{
			id: "finance.subscriptions",
			label: "Subscriptions",
			href: "/finance",
			icon: "WalletCards",
			placement: "sidebar",
			count: { endpoint: "/api/finance/badge" },
			keywords: ["finance", "money", "subscriptions", "renewals", "bills", "trials"],
			order: 20,
		},
	],
	messageSlots: [
		{
			id: "finance.track-message",
			slot: "message-menu",
			order: 50,
			label: "Track as subscription",
			icon: "WalletCards",
		},
		{
			id: "finance.add-document",
			slot: "message-menu",
			order: 51,
			label: "Add to a tracked subscription",
			icon: "WalletCards",
		},
	],
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
