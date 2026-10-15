import { z } from "zod";
import { isDayString } from "./date-utils";

const day = z.string().refine(isDayString, "Not a calendar date");
const instant = z.string().datetime({ offset: true });
const id = z.string().min(1).max(160);
const amountMinor = z.number().int().min(1).max(100_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/);
const cycle = z.enum(["weekly", "monthly", "quarterly", "yearly"]);
const status = z.enum(["active", "trial", "cancelled", "expired"]);

const fields = z
	.object({
		vendor: z.string().trim().min(1).max(80),
		plan: z.string().max(80).nullable(),
		amountMinor: amountMinor.nullable(),
		currency: currency.nullable(),
		cycle: cycle.nullable(),
		nextRenewalOn: day.nullable(),
		renewalEstimated: z.boolean(),
		trialEndsOn: day.nullable(),
		status,
		paymentFailedAt: instant.nullable(),
		reminderDays: z.number().int().min(0).max(30),
		calendarReminder: z.boolean(),
		cancelUrl: z
			.string()
			.max(2_048)
			.regex(/^https:\/\//)
			.nullable(),
		cancelOneClick: z.boolean(),
		previousAmountMinor: amountMinor.nullable(),
		priceChangedAt: instant.nullable(),
		lastMessageId: id.nullable(),
	})
	.strict();

const partialFields = fields.partial();

export const documentInputSchema = z
	.object({
		docType: z.enum(["invoice", "payment", "credit", "refund", "failed_payment"]),
		documentOn: day,
		periodStartOn: day.nullable(),
		periodEndOn: day.nullable(),
		attachmentId: id.nullable(),
		amountMinor: amountMinor.nullable(),
		currency: currency.nullable(),
	})
	.refine((document) => document.docType === "failed_payment" || document.amountMinor !== null, {
		message: "A document needs an amount",
	})
	.refine((document) => document.amountMinor === null || document.currency !== null, {
		message: "An amount needs a currency",
	});

const nullableMessage = id.nullable();

export const trackInput = z.discriminatedUnion("variant", [
	z.object({
		variant: z.literal(""),
		fields,
		vendorKey: z
			.string()
			.min(1)
			.max(120)
			.regex(/^[a-z0-9.:-]+$/),
		mailboxId: id.nullable(),
		contactId: id.nullable(),
		messageId: nullableMessage,
		source: z.enum(["suggestion", "manual"]),
		document: documentInputSchema.nullable(),
	}),
	z.object({
		variant: z.literal("update"),
		subscriptionId: id,
		changes: partialFields,
		previous: partialFields,
		messageId: nullableMessage,
		document: documentInputSchema.nullable(),
	}),
]);

const EDIT_KEYS = {
	"": [
		"vendor",
		"plan",
		"amountMinor",
		"currency",
		"cycle",
		"nextRenewalOn",
		"renewalEstimated",
		"trialEndsOn",
	] as const,
	reminder: ["reminderDays", "calendarReminder"] as const,
	payment_failed: ["paymentFailedAt"] as const,
};

type EditVariant = keyof typeof EDIT_KEYS;

/** The fields each `update_subscription` variant may change; anything else is refused by the schema. */
function editKeys(variant: EditVariant): readonly string[] {
	return EDIT_KEYS[variant];
}

export const editInput = z
	.object({
		variant: z.enum(["", "reminder", "payment_failed"]),
		subscriptionId: id,
		changes: partialFields,
		previous: partialFields.optional(),
		messageId: nullableMessage.optional(),
		document: documentInputSchema.nullable().optional(),
	})
	.refine((input) => Object.keys(input.changes).every((key) => editKeys(input.variant).includes(key)), {
		message: "These fields cannot be changed with this action",
	})
	.refine((input) => !input.document || input.document.docType === "failed_payment", {
		message: "Only a failed payment is recorded with a payment-failed change",
	});

export const statusInput = z.object({ variant: status, subscriptionId: id, previous: partialFields.optional() });

export const deleteSubscriptionInput = z.object({ subscriptionId: id });

export const recordInput = z
	.object({
		variant: z.enum(["invoice", "payment", "credit", "refund"]),
		subscriptionId: id,
		messageId: id,
		document: documentInputSchema,
		previous: partialFields.optional(),
	})
	.refine((input) => input.document.docType === input.variant, { message: "The document type is the variant" });

export const deleteDocumentInput = z.object({ documentId: id });

/** What an action stores for its undo (`agent_actions.before`): only what that action itself did. */
export const storedInverse = z.object({
	userId: id,
	subscriptionId: id,
	/** The subscription this action created; undo deletes it with its documents. */
	created: z.boolean().optional(),
	previous: partialFields.optional(),
	/** The row had a calendar event before this action; undo puts one back (never the old event id). */
	calendarEvent: z.boolean().optional(),
	/** Documents this action inserted; documents another action recorded are never listed. */
	documentIds: z.array(id).optional(),
	/** Rows this action removed, as JSON, put back with their ids. */
	removed: z
		.object({
			subscription: z.record(z.string(), z.unknown()).nullable(),
			documents: z.array(z.record(z.string(), z.unknown())),
		})
		.optional(),
});

export type StoredInverse = z.infer<typeof storedInverse>;
