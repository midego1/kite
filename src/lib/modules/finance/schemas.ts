import { z } from "zod";
import type { ModuleSchemas } from "../schema-utils";
import { resolveRefsSchemas } from "../shared-schemas";

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

export const financeSchemas: ModuleSchemas = {
	resolveRefs: resolveRefsSchemas(["finance:subscription"]),
	remindRenewals: {
		input: z.object({ scheduledTime: z.string().datetime({ offset: true }).optional() }),
		output: z.object({ reminded: z.number().int().min(0), skipped: z.literal("module_disabled").optional() }),
	},
	subscriptionDetected: { input: subscriptionDetected },
	renewalDue: { input: renewalDue },
};
