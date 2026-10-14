import { z } from "zod";
import { subscriptionSuggestion } from "@/lib/finance/payload-schema";
import type { ModuleSchemas } from "../schema-utils";
import { actionSchemas, resolveRefsSchemas, triageStepSchemas } from "../shared-schemas";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cycle = z.enum(["weekly", "monthly", "quarterly", "yearly"]);
const status = z.enum(["active", "trial", "cancelled", "expired"]);
const subscriptionRef = z.object({ kind: z.literal("finance:subscription"), id: z.string() });
const messageRef = z.object({ kind: z.literal("mail:message"), id: z.string() });

const subscriptionPayload = z.object({
	ref: subscriptionRef,
	vendor: z.string(),
	plan: z.string().nullable(),
	amount: z.object({ minor: z.number().int(), currency: z.string() }).nullable(),
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

export const financeSchemas: ModuleSchemas = {
	detect: triageStepSchemas,
	subscription: { input: subscriptionSuggestion },
	answerSubscription,
	trackSubscription: actionSchemas,
	editSubscription: actionSchemas,
	setSubscriptionStatus: actionSchemas,
	deleteSubscription: actionSchemas,
	recordDocument: actionSchemas,
	deleteDocument: actionSchemas,
	resolveRefs: resolveRefsSchemas(["finance:subscription"]),
	remindRenewals: {
		input: z.object({ scheduledTime: z.string().datetime({ offset: true }).optional() }),
		output: z.object({ reminded: z.number().int().min(0), skipped: z.literal("module_disabled").optional() }),
	},
	subscriptionDetected: { input: subscriptionDetected },
	renewalDue: { input: renewalDue },
};
