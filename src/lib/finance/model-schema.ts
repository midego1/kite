import { z } from "zod";

const modelDay = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);

/**
 * What the triage model may answer under `modules.finance` (spec §5.7.1). Each field is checked on its
 * own when parsing, so one invalid value never discards the others.
 */
export const financeModelSchema = z
	.object({
		vendor: z.string().max(80).nullable(),
		plan: z.string().max(80).nullable(),
		amount: z
			.string()
			.regex(/^[0-9]{1,9}([.][0-9]{1,3})?$/)
			.nullable(),
		currency: z
			.string()
			.regex(/^[A-Z]{3}$/)
			.nullable(),
		cycle: z.enum(["weekly", "monthly", "quarterly", "yearly"]).nullable(),
		nextRenewalOn: modelDay.nullable(),
		trialEndsOn: modelDay.nullable(),
		docType: z.enum(["invoice", "payment", "credit", "refund", "failed_payment"]).nullable(),
	})
	.strict();
