import type { CapabilityDescriptor, CapabilityEffect, ModuleCapabilities } from "../module-types";
import { describeCapability, type DescriptorMeta } from "../schema-utils";
import { financeSchemas } from "./schemas";

const REMIND_TIMEOUT_MS = 30_000;
const DETECT_TIMEOUT_MS = 15_000;
const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const describe = (name: string, meta: DescriptorMeta) => describeCapability(financeSchemas, name, meta);

type ActionRules = Pick<NonNullable<CapabilityDescriptor["action"]>, "variants" | "reopensSuggestion">;

const action = (name: string, actionType: string, effect: CapabilityEffect, description: string, rules: ActionRules) =>
	describe(name, {
		surfaces: ["action"],
		description,
		scopes: ["finance.write"],
		effect,
		action: {
			actionType,
			suggestionKind: "subscription",
			undoable: true,
			undoWindowMs: UNDO_WINDOW_MS,
			permission: "manage",
			...rules,
		},
	});

const webhook = (name: string, value: string, description: string) =>
	describe(name, { surfaces: ["webhook_event"], description, effect: "none", event: { value } });

export const financeCapabilities: ModuleCapabilities = {
	moduleId: "finance",
	promptFragment: null,
	descriptors: [
		describe("detect", {
			surfaces: ["triage_step"],
			description: "Find a subscription receipt, invoice, renewal or trial notice in a message and offer to track it.",
			scopes: ["finance.read"],
			effect: "read",
			timeoutMs: DETECT_TIMEOUT_MS,
			triage: { order: 20, automatic: true, capability: "subscriptions" },
		}),
		describe("subscription", {
			surfaces: ["suggestion_kind"],
			description: "A subscription found in a receipt or invoice, with its amount, cycle, renewal date and document.",
			effect: "none",
			suggestionKind: {
				kind: "subscription",
				label: "Subscription",
				reasonTemplate: "subscription",
				answer: "answerSubscription",
				audience: "reviewer",
			},
		}),
		describe("answerSubscription", {
			surfaces: ["service"],
			description:
				"Answer a subscription suggestion: track or update it, record a credit or refund, or mark it urgent.",
			scopes: ["finance.read", "finance.write"],
			effect: "create",
		}),
		action(
			"trackSubscription",
			"create_subscription",
			"create",
			"Track a subscription, or update it from a new invoice.",
			{
				variants: ["", "update"],
				reopensSuggestion: true,
			},
		),
		action(
			"editSubscription",
			"update_subscription",
			"update",
			"Change a subscription, its reminder or its failed payment.",
			{
				variants: ["", "reminder", "payment_failed"],
				reopensSuggestion: true,
			},
		),
		action("setSubscriptionStatus", "set_subscription_status", "update", "Change a subscription's status.", {
			variants: ["active", "trial", "cancelled", "expired"],
		}),
		action("deleteSubscription", "delete_subscription", "delete", "Remove a subscription and its documents.", {
			variants: [""],
		}),
		action("recordDocument", "record_document", "create", "Record an invoice, payment, credit note or refund.", {
			variants: ["invoice", "payment", "credit", "refund"],
			reopensSuggestion: true,
		}),
		action("deleteDocument", "delete_document", "delete", "Remove a subscription document.", { variants: [""] }),
		describe("resolveRefs", {
			surfaces: ["resolve_refs"],
			description: "Resolve subscription references to a link and a label.",
			scopes: ["finance.read"],
			effect: "read",
			refs: { kinds: ["finance:subscription"] },
		}),
		describe("remindRenewals", {
			surfaces: ["cron"],
			description: "Remind owners of tracked subscriptions that renew or end their trial soon.",
			scopes: ["finance.read", "finance.write"],
			effect: "update",
			timeoutMs: REMIND_TIMEOUT_MS,
			cron: { task: "remindRenewals" },
		}),
		webhook("subscriptionDetected", "finance.subscription.detected", "A subscription was added to Money Watch."),
		webhook("renewalDue", "finance.subscription.renewal_due", "A tracked subscription renews or its trial ends soon."),
	],
};
