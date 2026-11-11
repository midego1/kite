import { z } from "zod";
import { PAYMENT_CATEGORIES } from "./category-utils";
import { NO_CATEGORY, PAYMENT_STATUSES } from "./payment-filter-utils";

/** `list_payments` shows this many rows at most. */
const MAX_LIMIT = 50;

/** The input of `list_payments`; schema only, so the module's client-safe descriptors can import it. */
export const listPaymentsInput = z.object({
	month: z
		.string()
		.regex(/^\d{4}-(0[1-9]|1[0-2])$/)
		.optional()
		.describe("Only payments dated in this month, YYYY-MM"),
	vendor: z.string().trim().min(1).max(200).optional().describe("Only payments to or from this vendor, as listed"),
	category: z
		.enum([...PAYMENT_CATEGORIES, NO_CATEGORY])
		.optional()
		.describe("Only this category; none for payments without one"),
	status: z.enum(PAYMENT_STATUSES).optional().describe("Only payments with this status"),
	limit: z.number().int().min(1).max(MAX_LIMIT).default(20),
});
