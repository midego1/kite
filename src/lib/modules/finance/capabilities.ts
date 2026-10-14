import type { CapabilityDescriptor, CapabilityEffect, ModuleCapabilities } from "../module-types";
import { describeCapability, type DescriptorMeta } from "../schema-utils";
import { FINANCE_MODEL_JSON_SCHEMA, financeSchemas } from "./schemas";

const REMIND_TIMEOUT_MS = 30_000;
const DETECT_TIMEOUT_MS = 15_000;
const HINT_TIMEOUT_MS = 2_000;

/** Static key text for the triage prompt; it never carries message text (spec §5.7.1). */
const MODEL_INSTRUCTIONS =
	'"modules": {"finance": only for a receipt, invoice, refund, credit note, renewal or trial notice of a recurring subscription, else omit it: {"vendor": merchant as printed, "plan": plan name or null, "amount": amount charged, refunded or credited as a decimal string such as "17.99" or null, "currency": ISO 4217 code or null, "cycle": "weekly" | "monthly" | "quarterly" | "yearly" | null, "nextRenewalOn": "YYYY-MM-DD" or null, "trialEndsOn": "YYYY-MM-DD" or null, "docType": "invoice" (bill) | "payment" (paid receipt) | "credit" | "refund" | "failed_payment" | null}}';
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
			triage: {
				order: 20,
				automatic: true,
				capability: "subscriptions",
				model: {
					jsonSchema: FINANCE_MODEL_JSON_SCHEMA,
					instructions: MODEL_INSTRUCTIONS,
					maxOutputTokens: 200,
					wantsModel: "wantsModel",
				},
			},
		}),
		describe("wantsModel", {
			surfaces: ["service"],
			description: "Say whether a receipt the detector could not read completely is worth a model request.",
			effect: "none",
			timeoutMs: HINT_TIMEOUT_MS,
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
