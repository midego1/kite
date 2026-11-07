import { z } from "zod";

/**
 * The input of the `track_subscription` assistant tool. The model names what the user said and what the email
 * states; the approval preview replaces it with the fields the card shows (`mode`, `subscriptionId` and the document
 * fields are Kite's), and the user's edits on the card are merged into those before the tool runs.
 */

const MAX_TEXT = 80;
const id = z.string().trim().min(1).max(160);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** A decimal amount as written, "17.99" or "17,99"; at most 9 whole digits and 3 decimals. */
const AMOUNT_PATTERN = /^\d{1,9}(?:[.,]\d{1,3})?$/;

const CHAT_TRACK_CYCLES = ["weekly", "monthly", "quarterly", "yearly"] as const;
const CHAT_TRACK_DOC_TYPES = ["invoice", "payment", "credit", "refund"] as const;

export const chatTrackInputSchema = z.object({
	emailId: id
		.optional()
		.describe(
			"The email the receipt or invoice is in: the open email or one a tool returned. Leave it out to add a subscription the user described in the chat.",
		),
	vendor: z
		.string()
		.trim()
		.min(1)
		.max(MAX_TEXT)
		.nullable()
		.optional()
		.describe("The service, such as Netflix, only when the user named it or the email states it"),
	plan: z.string().trim().max(MAX_TEXT).nullable().optional().describe("The plan name, only when stated"),
	amount: z
		.string()
		.trim()
		.regex(AMOUNT_PATTERN, "Write the amount as a decimal such as 17.99")
		.nullable()
		.optional()
		.describe("The price per billing period as a decimal such as 17.99, only when stated"),
	currency: z
		.string()
		.trim()
		.regex(/^[A-Za-z]{3}$/, "Use an ISO 4217 code such as EUR")
		.transform((code) => code.toUpperCase())
		.nullable()
		.optional()
		.describe("ISO 4217 code such as EUR, only when stated"),
	cycle: z
		.enum(CHAT_TRACK_CYCLES)
		.nullable()
		.optional()
		.describe("The billing period, only when the user or the email states it; leave it out rather than guess"),
	nextRenewalOn: day.nullable().optional().describe("The next renewal date as YYYY-MM-DD, only when stated"),
	mode: z.enum(["track", "attach"]).optional().describe("Kite sets this; leave it out"),
	subscriptionId: id.nullable().optional().describe("Kite sets this; leave it out"),
	docType: z.enum(CHAT_TRACK_DOC_TYPES).nullable().optional().describe("Kite sets this; leave it out"),
	documentOn: day.nullable().optional().describe("Kite sets this; leave it out"),
	attachmentId: id.nullable().optional().describe("Kite sets this; leave it out"),
});

export type ChatTrackInput = z.infer<typeof chatTrackInputSchema>;

/** The fields the user may change on the approval card before it runs. */
export const CHAT_TRACK_EDITABLE = [
	"vendor",
	"plan",
	"amount",
	"currency",
	"cycle",
	"nextRenewalOn",
	"docType",
	"documentOn",
] as const;

const subscriptionRef = z.object({ kind: z.literal("finance:subscription"), id: z.string() });

export const chatTrackOutputSchema = z.object({
	result: z
		.object({
			status: z.enum(["tracked", "recorded"]),
			actionId: z.string(),
			subscription: subscriptionRef,
			documentRecorded: z.boolean().nullable(),
		})
		.nullable(),
	refused: z.object({ error: z.string().max(300) }).optional(),
});
