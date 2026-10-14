import { z } from "zod";
import { isDayString } from "@/lib/finance/date-utils";
import type { ModuleSchemas } from "../schema-utils";
import { resolveRefsSchemas, triageStepSchemas } from "../shared-schemas";

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

const day = date.refine(isDayString, "Not a calendar date");
const amountMinor = z.number().int().min(1).max(100_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/);
const shortText = z.string().max(80);

const subscriptionDocument = z
	.object({
		docType: z.enum(["invoice", "payment", "credit", "refund", "failed_payment"]),
		documentOn: day,
		periodStartOn: day.nullable(),
		periodEndOn: day.nullable(),
		attachmentId: z.string().min(1).max(160).nullable(),
	})
	.refine((document) => (document.periodStartOn === null) === (document.periodEndOn === null), {
		message: "A period needs both days",
	});

/** The `subscription` suggestion payload (spec §5.8); core validates step output and stored rows against it. */
const subscriptionSuggestion = z
	.object({
		event: z.enum(["new", "renewal", "price_change", "trial", "payment_failed", "refund"]),
		subscriptionId: z.string().min(1).max(160).nullable(),
		vendor: z.string().min(1).max(80),
		vendorKey: z
			.string()
			.min(1)
			.max(120)
			.regex(/^[a-z0-9.:-]+$/),
		plan: shortText.nullable(),
		amountMinor: amountMinor.nullable(),
		currency: currency.nullable(),
		previousAmountMinor: amountMinor.nullable(),
		cycle: cycle.nullable(),
		nextRenewalOn: day.nullable(),
		renewalEstimated: z.boolean(),
		trialEndsOn: day.nullable(),
		cancelLink: z
			.object({
				url: z
					.string()
					.max(2_048)
					.regex(/^https:\/\//),
				oneClick: z.boolean(),
			})
			.nullable(),
		document: subscriptionDocument.nullable(),
		unverified: z.boolean(),
		signals: z.array(z.string().max(40)).max(8),
		modelFields: z
			.array(z.enum(["vendor", "plan", "amount", "currency", "cycle", "nextRenewalOn", "trialEndsOn", "docType"]))
			.max(8),
		modelDisagrees: z.array(z.enum(["amount", "currency"])).max(2),
	})
	.refine((payload) => payload.amountMinor === null || payload.currency !== null, {
		message: "An amount needs a currency",
	})
	.refine((payload) => !["payment_failed", "refund"].includes(payload.event) || payload.subscriptionId !== null, {
		message: "Only a tracked subscription can have a failed payment or a refund",
	});

export const financeSchemas: ModuleSchemas = {
	detect: triageStepSchemas,
	subscription: { input: subscriptionSuggestion },
	resolveRefs: resolveRefsSchemas(["finance:subscription"]),
	remindRenewals: {
		input: z.object({ scheduledTime: z.string().datetime({ offset: true }).optional() }),
		output: z.object({ reminded: z.number().int().min(0), skipped: z.literal("module_disabled").optional() }),
	},
	subscriptionDetected: { input: subscriptionDetected },
	renewalDue: { input: renewalDue },
};
