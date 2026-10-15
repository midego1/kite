import { z } from "zod";
import { isCurrencyCode, MAX_AMOUNT_MINOR } from "./amount-utils";
import { addDays, addMonths, daysBetween, isDayString } from "./date-utils";

/** Request bodies of the Money Watch write routes, with the bounds of spec §5.4, §5.5 and §5.10. */

const MAX_TEXT = 80;
const MAX_PERIOD_DAYS = 366;
const id = z.string().min(1).max(160);
const amountMinor = z.number().int().min(1).max(MAX_AMOUNT_MINOR);
const currency = z.string().refine(isCurrencyCode, "Not an ISO 4217 currency code");
const cycle = z.enum(["weekly", "monthly", "quarterly", "yearly"]);
const status = z.enum(["active", "trial", "cancelled", "expired"]);
const vendor = z.string().trim().min(1).max(MAX_TEXT);
const plan = z.string().trim().max(MAX_TEXT).nullable();
const reminderDays = z.number().int().min(0).max(30);

type Window = { from: string; to: string };

/** Renewal and trial dates: up to 2 years ahead, and up to 5 years back for history. */
const fieldWindow = (today: string): Window => ({ from: addMonths(today, -60), to: addMonths(today, 24) });
/** Document dates: at most 1 day ahead and 5 years back. */
const documentWindow = (today: string): Window => ({ from: addMonths(today, -60), to: addDays(today, 1) });

function dayIn(window: Window) {
	return z
		.string()
		.refine(isDayString, "Not a calendar date")
		.refine(
			(day) => day >= window.from && day <= window.to,
			`The date must lie between ${window.from} and ${window.to}`,
		);
}

const amountNeedsCurrency = (value: { amountMinor?: number | null; currency?: string | null }) =>
	value.amountMinor === undefined || value.amountMinor === null || !!value.currency;
const CURRENCY_MESSAGE = { message: "An amount needs a currency", path: ["currency"] };

function documentObject(today: string) {
	const period = dayIn(fieldWindow(today)).nullable().optional();
	return z
		.object({
			docType: z.enum(["invoice", "payment", "credit", "refund"]),
			amountMinor,
			currency,
			documentOn: dayIn(documentWindow(today)),
			periodStartOn: period,
			periodEndOn: period,
			attachmentId: id.nullable().optional(),
		})
		.strict();
}

type DocumentShape = { periodStartOn?: string | null; periodEndOn?: string | null };

function withPeriodRules<T extends z.ZodType<DocumentShape>>(schema: T) {
	return schema
		.refine((value) => !value.periodStartOn === !value.periodEndOn, {
			message: "A period needs both a start and an end",
			path: ["periodEndOn"],
		})
		.refine(
			(value) =>
				!value.periodStartOn ||
				!value.periodEndOn ||
				(value.periodStartOn <= value.periodEndOn &&
					daysBetween(value.periodStartOn, value.periodEndOn) <= MAX_PERIOD_DAYS),
			{ message: "A period starts before it ends and covers at most 366 days", path: ["periodEndOn"] },
		);
}

const documentFields = (today: string) => withPeriodRules(documentObject(today));

export type DocumentBody = z.infer<ReturnType<typeof documentObject>>;

/** `POST /api/finance/subscriptions/[id]/documents`. */
export function documentBodySchema(today: string) {
	return withPeriodRules(documentObject(today).extend({ messageId: id }));
}

/** `POST /api/finance/subscriptions`: the dialog's fields, the audit mailbox and an optional source message. */
export function subscriptionBodySchema(today: string) {
	const day = dayIn(fieldWindow(today)).nullable().optional();
	return z
		.object({
			vendor,
			plan: plan.optional(),
			amountMinor: amountMinor.nullable().optional(),
			currency: currency.nullable().optional(),
			cycle: cycle.nullable().optional(),
			nextRenewalOn: day,
			trialEndsOn: day,
			status: status.optional(),
			reminderDays: reminderDays.optional(),
			calendarReminder: z.boolean().optional(),
			mailboxId: id.nullable().optional(),
			messageId: id.nullable().optional(),
			document: documentFields(today).nullable().optional(),
		})
		.strict()
		.refine(amountNeedsCurrency, CURRENCY_MESSAGE)
		.refine((value) => !value.document || !!value.messageId, {
			message: "A document needs the message it was recorded from",
			path: ["document"],
		});
}

export type SubscriptionBody = z.infer<ReturnType<typeof subscriptionBodySchema>>;

function editableFields(today: string) {
	const day = dayIn(fieldWindow(today)).nullable();
	return z
		.object({
			vendor,
			plan,
			amountMinor: amountMinor.nullable(),
			currency: currency.nullable(),
			cycle: cycle.nullable(),
			nextRenewalOn: day,
			trialEndsOn: day,
		})
		.partial()
		.strict()
		.refine((fields) => Object.keys(fields).length > 0, "Name at least one field to change")
		.refine((fields) => !fields.amountMinor || fields.currency !== null, CURRENCY_MESSAGE);
}

export type EditableFields = z.infer<ReturnType<typeof editableFields>>;

/** `PATCH /api/finance/subscriptions/[id]`: exactly one of an edit, a reminder change or a status. */
export function patchBodySchema(today: string) {
	return z.union([
		z.object({ fields: editableFields(today) }).strict(),
		z
			.object({ reminderDays: reminderDays.optional(), calendarReminder: z.boolean().optional() })
			.strict()
			.refine((value) => value.reminderDays !== undefined || value.calendarReminder !== undefined, {
				message: "Name the reminder days or the calendar reminder",
			}),
		z.object({ status }).strict(),
	]);
}

export type PatchBody = z.infer<ReturnType<typeof patchBodySchema>>;

/** `POST /api/finance/detect`. */
export const detectBodySchema = z.object({ messageId: id }).strict();

/** The first problem of an invalid body, as the 400 answer's error. */
export function bodyError(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "Invalid request";
	const path = issue.path.join(".");
	return path ? `${path}: ${issue.message}` : issue.message;
}
