import { z } from "zod";
import { financeModelSchema } from "@/lib/finance/model-schema";
import { subscriptionSuggestion } from "@/lib/finance/payload-schema";
import { toModelExtensionSchema, type ModuleSchemas } from "../schema-utils";
import { actionSchemas, resolveRefsSchemas, searchSchemas, triageStepSchemas } from "../shared-schemas";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cycle = z.enum(["weekly", "monthly", "quarterly", "yearly"]);
const status = z.enum(["active", "trial", "cancelled", "expired"]);
const subscriptionRef = z.object({ kind: z.literal("finance:subscription"), id: z.string() });
const messageRef = z.object({ kind: z.literal("mail:message"), id: z.string() });
const money = z.object({ minor: z.number().int(), currency: z.string() });

const subscriptionPayload = z.object({
	ref: subscriptionRef,
	vendor: z.string(),
	plan: z.string().nullable(),
	amount: money.nullable(),
	cycle: cycle.nullable(),
	status,
	nextRenewalOn: date.nullable(),
	trialEndsOn: date.nullable(),
});

const subscriptionDetected = z.object({
	subscription: subscriptionPayload,
	source: z.enum(["suggestion", "manual"]),
	message: messageRef.nullable(),
});

const renewalDue = z.object({
	subscription: subscriptionPayload,
	due: z.object({ on: date, kind: z.enum(["renewal", "trial_end"]), daysLeft: z.number().int().min(0) }),
});

const answerSubscription: ModuleSchemas[string] = {
	input: z.object({
		suggestionId: z.string().min(1),
		option: z.string().max(40),
		deviceTimeZone: z.string().nullable(),
	}),
	output: z.object({
		result: z
			.object({
				status: z.literal("accepted"),
				option: z.string(),
				actionId: z.string(),
				subscription: subscriptionRef,
				documentRecorded: z.boolean().nullable(),
			})
			.nullable(),
		refused: z
			.object({
				status: z.union([z.literal(400), z.literal(403), z.literal(404), z.literal(409)]),
				error: z.string(),
			})
			.optional(),
	}),
};

const listSubscriptions: ModuleSchemas[string] = {
	input: z.object({
		status: z
			.enum(["active", "trial", "cancelled", "expired", "all"])
			.optional()
			.describe("Which rows to list; active and trial rows when left out"),
		dueWithinDays: z
			.number()
			.int()
			.min(1)
			.max(366)
			.optional()
			.describe("Only rows that renew or end their trial within this many days from today"),
		limit: z.number().int().min(1).max(50).default(20),
	}),
	output: z.object({
		subscriptions: z.array(
			z.object({
				ref: subscriptionRef,
				vendor: z.string(),
				plan: z.string().nullable(),
				amount: money.nullable(),
				cycle: cycle.nullable(),
				status,
				nextRenewalOn: date.nullable(),
				trialEndsOn: date.nullable(),
				urgent: z.boolean(),
			}),
		),
		totals: z.array(
			z.object({
				currency: z.string(),
				monthlyMinor: z.number().int(),
				yearlyMinor: z.number().int(),
				paidLast12MonthsMinor: z.number().int(),
			}),
		),
	}),
};

/** The `modules.finance` fragment core merges into the triage request's provider schema (spec §5.7.1). */
export const FINANCE_MODEL_JSON_SCHEMA = toModelExtensionSchema(financeModelSchema);

export const financeSchemas: ModuleSchemas = {
	detect: triageStepSchemas,
	wantsModel: { input: triageStepSchemas.input, output: z.object({ wantsModel: z.boolean() }) },
	subscription: { input: subscriptionSuggestion },
	answerSubscription,
	trackSubscription: actionSchemas,
	editSubscription: actionSchemas,
	setSubscriptionStatus: actionSchemas,
	deleteSubscription: actionSchemas,
	recordDocument: actionSchemas,
	deleteDocument: actionSchemas,
	resolveRefs: resolveRefsSchemas(["finance:subscription"]),
	search: searchSchemas,
	list_subscriptions: listSubscriptions,
	remindRenewals: {
		input: z.object({ scheduledTime: z.string().datetime({ offset: true }).optional() }),
		output: z.object({ reminded: z.number().int().min(0), skipped: z.literal("module_disabled").optional() }),
	},
	subscriptionDetected: { input: subscriptionDetected },
	renewalDue: { input: renewalDue },
};
