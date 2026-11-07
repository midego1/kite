import { z } from "zod";
import type { CapabilityCallContext, CapabilityHandler, JsonValue } from "@/lib/modules/module-types";
import { isDayString } from "./date-utils";
import { FinanceRefusal, refusalOf } from "./errors";
import { initialStatus, referenceNumber, rowReference, type PaymentDocType, type PaymentStatus } from "./payment-utils";
import { ownerPayment, removePaymentRow, updatePayment, type PaymentRow } from "./payments";
import { dayToDate } from "./record-utils";
import { manualVendorKey } from "./vendor-utils";

const day = z.string().refine(isDayString, "Not a calendar date");
const docType = z.enum(["invoice", "payment", "credit", "refund"]);
const status = z.enum(["open", "paid", "refunded", "credited"]);

/** What a correction may change; the status of anything but an invoice follows its type. */
export const paymentFieldsSchema = z
	.object({
		vendor: z.string().trim().min(1).max(80),
		amountMinor: z.number().int().min(1).max(100_000_000),
		currency: z.string().regex(/^[A-Z]{3}$/),
		documentOn: day,
		docType,
		status,
	})
	.partial()
	.strict();

export type PaymentFields = z.infer<typeof paymentFieldsSchema>;

const updateInput = z.object({ paymentId: z.string().min(1).max(160), fields: paymentFieldsSchema });
const removeInput = z.object({ paymentId: z.string().min(1).max(160) });

/** The columns an undo puts back, as JSON. */
const previousSchema = z
	.object({
		vendor: z.string(),
		vendorKey: z.string(),
		amountMinor: z.number().int(),
		currency: z.string(),
		docRef: z.string().nullable(),
		documentAt: z.string().datetime({ offset: true }),
		docType,
		status,
		removedAt: z.string().datetime({ offset: true }).nullable(),
	})
	.partial();

const inverseSchema = z.object({ userId: z.string(), paymentId: z.string(), previous: previousSchema });

type Previous = z.infer<typeof previousSchema>;

/** A status that fits the type: an invoice is open or paid, every other type has one status. */
function statusFor(type: PaymentDocType, wanted: PaymentStatus | undefined, current: PaymentStatus): PaymentStatus {
	if (type !== "invoice") return initialStatus(type);
	const next = wanted ?? current;
	return next === "paid" ? "paid" : "open";
}

/**
 * The row's dedupe reference after a correction. A payment's, refund's or credit note's carries its amount and
 * currency (`A12345:1500EUR`, see `rowReference`), so a corrected amount, currency or type changes it: left alone, the
 * same document arriving again at the corrected amount would be recorded a second time.
 */
function correctedReference(row: PaymentRow, type: PaymentDocType, amount: { minor: number; currency: string }) {
	const reference = rowReference(type, referenceNumber(row.docRef), amount);
	return reference === row.docRef ? {} : { docRef: reference };
}

/** The columns a correction writes, from the row as it was and the fields asked for. */
function correctedColumns(row: PaymentRow, fields: PaymentFields) {
	const type = fields.docType ?? row.docType;
	const amount = {
		minor: fields.amountMinor ?? row.amountMinor,
		currency: fields.currency ?? row.currency,
	};
	return {
		...correctedReference(row, type, amount),
		// A renamed vendor pairs only with its own rows, not with the sender's original ones.
		...(fields.vendor !== undefined && fields.vendor !== row.vendor
			? { vendor: fields.vendor, vendorKey: manualVendorKey(fields.vendor) }
			: {}),
		...(fields.amountMinor !== undefined ? { amountMinor: fields.amountMinor } : {}),
		...(fields.currency !== undefined ? { currency: fields.currency } : {}),
		...(fields.documentOn !== undefined ? { documentAt: dayToDate(fields.documentOn)! } : {}),
		docType: type,
		status: statusFor(type, fields.status, row.status),
	};
}

function snapshot(row: PaymentRow): Previous {
	return {
		vendor: row.vendor,
		vendorKey: row.vendorKey,
		amountMinor: row.amountMinor,
		currency: row.currency,
		docRef: row.docRef,
		documentAt: row.documentAt.toISOString(),
		docType: row.docType,
		status: row.status,
		removedAt: row.removedAt ? row.removedAt.toISOString() : null,
	};
}

function columnsOf(previous: Previous) {
	const { documentAt, removedAt, ...rest } = previous;
	return {
		...rest,
		...(documentAt !== undefined ? { documentAt: new Date(documentAt) } : {}),
		...(removedAt !== undefined ? { removedAt: removedAt ? new Date(removedAt) : null } : {}),
	};
}

/** The row before the action ran: the `before` its caller saved when it names this row, else the row as it is. */
function priorOf(before: unknown, row: PaymentRow): Previous {
	const parsed = previousSchema.safeParse(before);
	const named = !!before && typeof before === "object" && (before as { id?: unknown }).id === row.id;
	return named && parsed.success ? parsed.data : snapshot(row);
}

const resultOf = (row: PaymentRow): Record<string, JsonValue> => ({
	paymentId: row.id,
	...(row.messageId ? { ref: { kind: "mail:message", id: row.messageId } } : {}),
});

/**
 * Writes a correction or its undo; 409 when the vendor, type and document number (or the Message-ID) would repeat
 * another row's, for example after another row took the values an undo puts back.
 */
async function updateOrRefuse(userId: string, id: string, columns: Parameters<typeof updatePayment>[2]): Promise<void> {
	try {
		await updatePayment(userId, id, columns);
	} catch (error) {
		const text = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
		if (/UNIQUE constraint failed/i.test(text))
			throw new FinanceRefusal(409, "Another payment already records this document");
		throw error;
	}
}

type RawCall =
	| { op: "execute"; actionId: string; input?: JsonValue; before?: JsonValue }
	| { op: "undo" | "authorize_undo"; actionId: string; inverse: { inverse: JsonValue } };

type Execute<Input> = (call: { userId: string; input: Input; before: unknown }) => Promise<{
	result: Record<string, JsonValue>;
	inverse: z.infer<typeof inverseSchema>;
}>;

async function run<Input>(
	raw: JsonValue,
	ctx: CapabilityCallContext,
	schema: z.ZodType<Input>,
	execute: Execute<Input>,
) {
	const viewer = ctx.viewer;
	if (!viewer) throw new FinanceRefusal(403, "This action needs a signed-in user");
	const call = raw as unknown as RawCall;
	if (call.op === "execute") {
		const input = schema.safeParse(call.input);
		if (!input.success) throw new FinanceRefusal(409, "The action's input is not valid");
		const outcome = await execute({ userId: viewer.userId, input: input.data, before: call.before });
		return { result: outcome.result, inverse: JSON.parse(JSON.stringify(outcome.inverse)) as JsonValue };
	}
	const inverse = inverseSchema.safeParse(call.inverse?.inverse);
	// Without what to put back there is nothing to undo, so the undo is refused rather than reported as done.
	if (!inverse.success) throw new FinanceRefusal(409, "This change cannot be undone");
	if (inverse.data.userId !== viewer.userId) throw new FinanceRefusal(403, "Only the owner can change this payment");
	if (call.op === "undo")
		await updateOrRefuse(inverse.data.userId, inverse.data.paymentId, columnsOf(inverse.data.previous));
	return { result: {}, inverse: null };
}

/** A payment action handler: execute, undo and the check before an undo, each idempotent; refusals are answered. */
function paymentAction<Input>(schema: z.ZodType<Input>, execute: Execute<Input>): CapabilityHandler {
	return async (raw, ctx) => {
		try {
			return await run(raw, ctx, schema, execute);
		} catch (error) {
			const refusal = refusalOf(error);
			if (!refusal) throw error;
			return {
				result: {},
				inverse: null,
				refused: { status: refusal.status === 403 ? 403 : 409, error: refusal.error },
			};
		}
	};
}

async function requirePayment(userId: string, id: string): Promise<PaymentRow> {
	const row = await ownerPayment(userId, id);
	if (!row) throw new FinanceRefusal(409, "The payment is no longer in Money Watch");
	return row;
}

/** `update_payment`: corrects the vendor, amount, currency, date, type or status; undo puts the old values back. */
export const updatePaymentAction = paymentAction(updateInput, async ({ userId, input, before }) => {
	const row = await requirePayment(userId, input.paymentId);
	const prior = priorOf(before, row);
	await updateOrRefuse(userId, row.id, correctedColumns(row, input.fields));
	const { removedAt: _removed, ...previous } = prior;
	return { result: resultOf(row), inverse: { userId, paymentId: row.id, previous } };
});

/**
 * `remove_payment`: hides the row and keeps it as a tombstone so the message is not recorded again; undo shows it.
 * Only the action whose update hid the row records an undo: a second removal of a row already removed is refused, so
 * its undo can never bring back a row another action removed.
 */
export const removePaymentAction = paymentAction(removeInput, async ({ userId, input }) => {
	const row = await requirePayment(userId, input.paymentId);
	if (!(await removePaymentRow(userId, row.id))) throw new FinanceRefusal(409, "This payment was already removed");
	return { result: resultOf(row), inverse: { userId, paymentId: row.id, previous: { removedAt: null } } };
});
